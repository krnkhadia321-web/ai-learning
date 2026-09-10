import { SpanKind } from '@opentelemetry/api';

// Project 02's tools, unchanged. The registry, validation and authorization all still
// live there — this project adds measurement around them, not new behaviour.
import { TOOLS, toolDefinitions } from '../../02-tool-calling/src/tools.js';

import { chat } from './llm.js';
import { tracer, GENAI, captureContent, failSpan } from './genai.js';

/**
 * Teaching affordance: hide tools from the model.
 *
 *   DISABLE_TOOLS=get_current_time npm run dev --workspace=03-observability
 *
 * Why this exists: the headline lesson of this project is catching an answer that is
 * right for the wrong reason. But you can't reproduce that on demand by hoping the
 * model misbehaves — a capable model usually calls the clock, and you get a healthy
 * trace instead of the bug you were trying to see.
 *
 * Taking the clock away makes it deterministic. The model cannot look up the date, so
 * it either admits it doesn't know (rare) or states one confidently (common). Either
 * way `tools_used` shows no clock, which is exactly the signal you're learning to spot.
 *
 * It also mirrors a real production failure: a tool that is broken, rate-limited or
 * mis-registered silently disappears from the model's options, and the model papers
 * over the gap with a guess instead of failing loudly.
 */
const DISABLED_TOOLS = (process.env.DISABLE_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const availableTools = toolDefinitions.filter(
  (t) => !DISABLED_TOOLS.includes(t.function.name),
);

if (DISABLED_TOOLS.length) {
  console.warn(
    `⚠  DISABLE_TOOLS is set — hiding from the model: ${DISABLED_TOOLS.join(', ')}\n` +
      `   The model now has ${availableTools.length} of ${toolDefinitions.length} tools.`,
  );
}

const SYSTEM_PROMPT = `You are a customer support assistant for an online store.

Use the provided tools to look up real information. Never guess an order status, a
price, or the current date — call the appropriate tool instead.

If a tool reports that something was not found, tell the user plainly.

Keep replies short and concrete.`;

/**
 * The project 02 agent loop, instrumented.
 *
 * THE SHAPE OF THE TRACE is the lesson here:
 *
 *   invoke_agent support-agent            ← one span for the whole question
 *   ├── chat openai/gpt-oss-120b          ← iteration 1: model decides
 *   ├── execute_tool get_order_status     ← your server runs the function
 *   ├── chat openai/gpt-oss-120b          ← iteration 2: model decides again
 *   ├── execute_tool get_current_time
 *   └── chat openai/gpt-oss-120b          ← iteration 3: final answer
 *
 * Read that top to bottom and you can see exactly what the model chose to do, in
 * order, with timings and token counts on every step. That waterfall is the thing a
 * log line can never give you — and it's how you catch a model that answered a
 * date question without ever calling the clock tool.
 */
export async function* runAgent({
  question,
  provider,
  userId = 'u_1',
  maxIterations = 6,
  signal,
} = {}) {
  // The ROOT span. Everything below becomes a child automatically, because
  // startActiveSpan puts it on the async context — that's how the parent/child
  // relationship is established without threading a variable through every function.
  const rootSpan = tracer.startSpan('invoke_agent support-agent', {
    kind: SpanKind.INTERNAL,
    attributes: {
      [GENAI.OPERATION]: 'invoke_agent',
      'gen_ai.agent.name': 'support-agent',
      'enduser.id': userId,
      'gen_ai.request.max_iterations': maxIterations,
    },
  });
  captureContent(rootSpan, 'gen_ai.input.question', question);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const ctx = { userId };

  let totalTokens = 0;
  let totalCost = 0;
  const toolsUsed = [];

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      yield { type: 'thinking', iteration };

      const result = await chat({
        provider,
        messages,
        tools: availableTools,
        toolChoice: 'auto',
        signal,
        userId,
        operation: 'chat',
      });

      totalTokens += (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0);
      totalCost += result.cost.usd;

      messages.push(result.message);
      const toolCalls = result.message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // Summary attributes on the ROOT span. Putting the totals here is what lets
        // you sort traces by "most expensive conversation" — a per-call cost tells
        // you nothing about which user question was pathological.
        rootSpan.setAttributes({
          'gen_ai.agent.iterations': iteration,
          'gen_ai.usage.total_tokens': totalTokens,
          'gen_ai.usage.cost_usd': totalCost,
          // The list of tools ACTUALLY invoked across the run. This is the attribute
          // that catches "right answer, wrong process" — a question about dates that
          // completed with an empty tool list did not consult a clock.
          'gen_ai.agent.tools_used': toolsUsed,
          'gen_ai.agent.tool_count': toolsUsed.length,
        });
        captureContent(rootSpan, 'gen_ai.output.answer', result.message.content ?? '');

        yield {
          type: 'answer',
          text: result.message.content ?? '',
          iterations: iteration,
          totalTokens,
          costUsd: totalCost,
          toolsUsed,
        };
        return;
      }

      const executed = await Promise.all(toolCalls.map((call) => executeToolCall(call, ctx)));

      for (const { call, event, toolMessage } of executed) {
        if (event.type === 'tool_result') toolsUsed.push(event.name);
        yield event;
        messages.push(toolMessage);

        if (event.type === 'approval_required') {
          rootSpan.setAttributes({
            'gen_ai.agent.iterations': iteration,
            'gen_ai.usage.total_tokens': totalTokens,
            'gen_ai.usage.cost_usd': totalCost,
            'gen_ai.agent.halted_reason': 'awaiting_human_approval',
          });
          yield {
            type: 'answer',
            text: `This action needs your approval: ${call.function.name}(${call.function.arguments})`,
            iterations: iteration,
            totalTokens,
            costUsd: totalCost,
            toolsUsed,
            awaitingApproval: true,
          };
          return;
        }
      }
    }

    rootSpan.setAttributes({
      'gen_ai.agent.halted_reason': 'max_iterations',
      'gen_ai.usage.total_tokens': totalTokens,
      'gen_ai.usage.cost_usd': totalCost,
      'gen_ai.agent.tools_used': toolsUsed,
    });
    yield {
      type: 'error',
      message: `Stopped after ${maxIterations} iterations without an answer.`,
      totalTokens,
      costUsd: totalCost,
    };
  } catch (err) {
    failSpan(rootSpan, err);
    throw err;
  } finally {
    rootSpan.end();
  }
}

/**
 * Execute one tool call inside its own span.
 *
 * Tools get spans for the same reason database queries do: when a request is slow,
 * "the LLM was slow" and "our own order lookup took 3 seconds" look identical from
 * the outside, and the fix is completely different.
 */
async function executeToolCall(call, ctx) {
  const name = call.function?.name;
  const rawArgs = call.function?.arguments ?? '{}';

  return tracer.startActiveSpan(
    `execute_tool ${name}`,
    { kind: SpanKind.INTERNAL },
    async (span) => {
      span.setAttributes({
        [GENAI.OPERATION]: 'execute_tool',
        [GENAI.TOOL_NAME]: name ?? 'unknown',
        [GENAI.TOOL_CALL_ID]: call.id ?? '',
      });
      captureContent(span, 'gen_ai.tool.arguments', rawArgs);

      const reply = (payload, event, spanAttrs = {}) => {
        span.setAttributes(spanAttrs);
        captureContent(span, 'gen_ai.tool.result', payload);
        span.end();
        return {
          call,
          event,
          toolMessage: { role: 'tool', tool_call_id: call.id, content: JSON.stringify(payload) },
        };
      };

      const tool = TOOLS[name];
      if (!tool) {
        return reply(
          { error: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` },
          { type: 'tool_error', name, error: 'unknown tool' },
          // A dedicated attribute, because "the model is hallucinating tool names" is
          // a specific failure you want to be able to search for and alert on.
          { 'gen_ai.tool.outcome': 'hallucinated_name' },
        );
      }

      let args;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        return reply(
          { error: 'Arguments were not valid JSON. Call the tool again with valid JSON.' },
          { type: 'tool_error', name, error: 'invalid JSON arguments', rawArgs },
          { 'gen_ai.tool.outcome': 'unparseable_arguments' },
        );
      }

      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return reply(
          { error: `Invalid arguments: ${problems}` },
          { type: 'tool_error', name, error: problems, args },
          { 'gen_ai.tool.outcome': 'validation_failed', 'gen_ai.tool.validation_errors': problems },
        );
      }

      if (tool.requiresApproval) {
        return reply(
          { status: 'awaiting_human_approval', message: 'Not executed. A human must approve.' },
          { type: 'approval_required', name, args: parsed.data },
          { 'gen_ai.tool.outcome': 'approval_required' },
        );
      }

      try {
        const output = await tool.execute(parsed.data, ctx);
        return reply(
          output,
          { type: 'tool_result', name, args: parsed.data, output },
          { 'gen_ai.tool.outcome': 'ok' },
        );
      } catch (err) {
        span.recordException(err);
        return reply(
          { error: `Tool failed: ${err.message}` },
          { type: 'tool_error', name, error: err.message, args: parsed.data },
          { 'gen_ai.tool.outcome': 'threw' },
        );
      }
    },
  );
}
