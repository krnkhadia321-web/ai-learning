import { TOOLS, toolDefinitions } from '../../02-tool-calling/src/tools.js';
import { chat } from './llm.js';

/**
 * Project 02's tool loop, trimmed to what this project needs.
 *
 * It's here for one reason: **`toolsUsed` is the cacheability signal.** Without a tool
 * loop there'd be nothing to demonstrate guard 2 against, and that guard is the most
 * useful idea in the project.
 */

const SYSTEM_PROMPT = `You are a customer support assistant for an online store.

Use the provided tools for anything about a specific order, price or the current date.
Answer general policy questions directly without tools.

Keep replies short and concrete.`;

export async function runAgent({ question, model, userId = 'u_1', maxIterations = 5, signal }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const ctx = { userId };
  const toolsUsed = [];
  let costUsd = 0;
  let tokens = 0;

  for (let i = 1; i <= maxIterations; i++) {
    const result = await chat({
      model,
      messages,
      tools: toolDefinitions,
      toolChoice: 'auto',
      signal,
    });

    costUsd += result.cost.usd;
    tokens += (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0);
    messages.push(result.message);

    const calls = result.message.tool_calls ?? [];
    if (calls.length === 0) {
      return { answer: result.message.content ?? '', toolsUsed, costUsd, tokens, iterations: i };
    }

    for (const call of calls) {
      const tool = TOOLS[call.function?.name];
      let payload;

      if (!tool) {
        payload = { error: `Unknown tool "${call.function?.name}"` };
      } else {
        try {
          const args = JSON.parse(call.function.arguments ?? '{}');
          const parsed = tool.parameters.safeParse(args);
          if (!parsed.success) {
            payload = { error: parsed.error.issues.map((x) => x.message).join('; ') };
          } else if (tool.requiresApproval) {
            payload = { status: 'awaiting_human_approval' };
            toolsUsed.push(call.function.name);
          } else {
            payload = await tool.execute(parsed.data, ctx);
            toolsUsed.push(call.function.name);
          }
        } catch (err) {
          payload = { error: err.message };
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(payload),
      });
    }
  }

  return {
    answer: `Stopped after ${maxIterations} iterations without an answer.`,
    toolsUsed,
    costUsd,
    tokens,
    iterations: maxIterations,
    halted: true,
  };
}
