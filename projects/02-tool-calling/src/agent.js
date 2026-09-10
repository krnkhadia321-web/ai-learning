import { chat } from './llm.js';
import { TOOLS, toolDefinitions } from './tools.js';

/**
 * THE TOOL LOOP.
 *
 * A single LLM call cannot answer "where is my order?" — it has no database. So the
 * conversation goes:
 *
 *   1. You  → model:  question + "here are the tools you may ask me to run"
 *   2. model → you:   "please run get_order_status({orderId: 'A-1001'})"
 *   3. You:           validate the arguments, decide whether to allow it, run it
 *   4. You  → model:  "here is the result: {...}"
 *   5. model → you:   either a final answer, or ANOTHER tool request (back to 3)
 *
 * That loop is the entire mechanism behind every "AI agent" you've heard of. There is
 * no magic layer underneath: it's a while-loop around a chat API, and the only thing
 * that makes one agent better than another is the quality of the tools, the validation,
 * and the stopping rules.
 *
 * Emitted as an async generator so the server can stream each step to the UI — reusing
 * project 01's transport to make the loop visible while it happens.
 */

const SYSTEM_PROMPT = `You are a customer support assistant for an online store.

Use the provided tools to look up real information. Never guess an order status, a
price, or the current date — call the appropriate tool instead.

If a tool reports that something was not found, tell the user plainly. Do not speculate
about why, and do not retry the same call with a different ID hoping it works.

Keep replies short and concrete.`;

export async function* runAgent({
  question,
  provider,
  userId = 'u_1',
  // THE ITERATION CAP is not optional.
  //
  // Without it: a model that misreads a tool result can call the same tool forever,
  // each iteration adding to the conversation, each call costing money and growing the
  // context. It looks exactly like a hang. This single number is the difference
  // between a bounded system and an unbounded bill.
  maxIterations = 6,
  signal,
} = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];

  const ctx = { userId }; // the REAL identity — never taken from model output
  let totalTokens = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    yield { type: 'thinking', iteration };

    const { message, usage, finishReason } = await chat({
      provider,
      messages,
      tools: toolDefinitions,
      // 'auto' = the model decides whether to use a tool or just answer. ('required'
      // forces a tool call, 'none' forbids one — both useful when you know better
      // than the model what this step needs.)
      toolChoice: 'auto',
      signal,
    });

    totalTokens += usage?.total_tokens ?? 0;

    // The assistant's message MUST go into the history before the tool results,
    // including its tool_calls. The API matches each tool result to the call it
    // answers by ID — drop this message and the next request is rejected as malformed.
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];

    // No tool requested → this is the final answer, and the loop ends.
    if (toolCalls.length === 0) {
      yield {
        type: 'answer',
        text: message.content ?? '',
        iterations: iteration,
        totalTokens,
        finishReason,
      };
      return;
    }

    // A model can request SEVERAL tools at once when they don't depend on each other
    // (e.g. two different order lookups). Running them in parallel is free latency.
    // They must all be answered before the next model call.
    const results = await Promise.all(
      toolCalls.map((call) => executeToolCall(call, ctx)),
    );

    for (const { call, event, toolMessage } of results) {
      yield event;
      messages.push(toolMessage);

      // Stop the whole loop on an action awaiting human approval. We do NOT feed a
      // fake result back and let the model carry on as if it happened.
      if (event.type === 'approval_required') {
        yield {
          type: 'answer',
          text: `This action needs your approval: ${call.function.name}(${call.function.arguments})`,
          iterations: iteration,
          totalTokens,
          awaitingApproval: true,
        };
        return;
      }
    }
  }

  // Hit the cap. Report it honestly rather than pretending we finished — a truncated
  // agent run that looks like a normal answer is worse than a visible failure.
  yield {
    type: 'error',
    message: `Stopped after ${maxIterations} iterations without reaching an answer. ` +
      `The model kept requesting tools — usually a sign of an unhelpful tool result ` +
      `or an ambiguous question.`,
    totalTokens,
  };
}

/**
 * Run ONE tool call safely.
 *
 * Every branch here returns a tool message rather than throwing. That's deliberate:
 * an error is information the model can act on ("that order ID was malformed, ask the
 * user for the right one"), whereas an exception kills the run and tells the user
 * nothing useful.
 */
async function executeToolCall(call, ctx) {
  const name = call.function?.name;
  const rawArgs = call.function?.arguments ?? '{}';

  const reply = (payload, event) => ({
    call,
    event,
    toolMessage: {
      role: 'tool',
      tool_call_id: call.id, // must match, or the next request is rejected
      content: JSON.stringify(payload),
    },
  });

  const tool = TOOLS[name];

  // Models hallucinate tool names — usually plausible ones like `get_order` or
  // `lookup_order`. Never index into your registry without checking.
  if (!tool) {
    return reply(
      { error: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` },
      { type: 'tool_error', name, error: 'unknown tool' },
    );
  }

  // Arguments arrive as a STRING of JSON, not an object, and it is not guaranteed to
  // parse. Weaker models produce truncated or doubly-escaped JSON here regularly.
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return reply(
      { error: 'Arguments were not valid JSON. Call the tool again with valid JSON.' },
      { type: 'tool_error', name, error: 'invalid JSON arguments', rawArgs },
    );
  }

  // VALIDATE BEFORE EXECUTING. This is the security boundary: the JSON Schema we sent
  // the model is documentation, not enforcement. Nothing stops the model returning
  // orderId: "'; DROP TABLE orders;--" except this check.
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return reply(
      { error: `Invalid arguments: ${problems}` },
      { type: 'tool_error', name, error: problems, args },
    );
  }

  // Destructive actions stop here and wait for a human.
  if (tool.requiresApproval) {
    return reply(
      { status: 'awaiting_human_approval', message: 'Not executed. A human must approve.' },
      { type: 'approval_required', name, args: parsed.data },
    );
  }

  try {
    const output = await tool.execute(parsed.data, ctx);
    return reply(output, { type: 'tool_result', name, args: parsed.data, output });
  } catch (err) {
    // A tool crashing should not crash the agent. Report it as a result and let the
    // model decide what to tell the user.
    return reply(
      { error: `Tool failed: ${err.message}` },
      { type: 'tool_error', name, error: err.message, args: parsed.data },
    );
  }
}
