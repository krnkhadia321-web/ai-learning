/**
 * Chat client with cost accounting — project 03's, minus the OpenTelemetry wiring.
 *
 * Cost matters more here than anywhere else in the ladder: this whole project is about
 * making the number smaller, so every path has to report what it actually spent.
 */

const BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * ⚠️ PLACEHOLDER RATES — USD per 1,000,000 tokens. Not verified against Groq's
 * pricing page, and the free tier bills nothing at all. The *mechanism* transfers;
 * the constants don't. Never quote a figure from here as fact.
 *
 * What does matter, and is true of essentially every provider: the strong model costs
 * about 2× the cheap one, and output costs about 4× input. Those ratios drive the
 * break-even maths in router.js.
 */
export const PRICING = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
};

const DEFAULT_RATE = { input: 0.1, output: 0.4 };

export function computeCost(model, inputTokens = 0, outputTokens = 0) {
  const rate = PRICING[model] ?? DEFAULT_RATE;
  return {
    usd: (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000,
    estimated: !PRICING[model],
  };
}

export class LlmError extends Error {
  constructor(status, body) {
    super(`LLM call failed (${status}): ${String(body).slice(0, 300)}`);
    this.name = 'LlmError';
    this.status = status;
  }
}

export async function chat({ model, messages, tools, toolChoice, temperature = 0, signal }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in .env');

  const body = { model, messages, temperature };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new LlmError(res.status, await res.text().catch(() => ''));

  const data = await res.json();
  const usage = data.usage ?? {};
  const cost = computeCost(
    data.model ?? model,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
  );

  return {
    message: data.choices?.[0]?.message ?? {},
    finishReason: data.choices?.[0]?.finish_reason,
    usage,
    model: data.model ?? model,
    cost,
    durationMs: Date.now() - startedAt,
  };
}
