/**
 * Chat client — project 04's, trimmed. Same placeholder pricing caveat applies:
 * the provider returns tokens, the dollar figures come from a hardcoded unverified
 * table, and the free tier bills nothing.
 */

const BASE_URL = 'https://api.groq.com/openai/v1';

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

export async function chat({
  model = process.env.GROQ_TOOL_MODEL ?? 'openai/gpt-oss-120b',
  messages,
  responseFormat,
  // Temperature 0: grounded answering is extraction, not writing. Randomness here is
  // pure downside — the same question and the same passages should give the same
  // answer, every time.
  temperature = 0,
  signal,
}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in .env');

  const body = { model, messages, temperature };
  if (responseFormat) body.response_format = responseFormat;

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

  return {
    message: data.choices?.[0]?.message ?? {},
    finishReason: data.choices?.[0]?.finish_reason,
    usage,
    model: data.model ?? model,
    cost: computeCost(data.model ?? model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
    durationMs: Date.now() - startedAt,
  };
}
