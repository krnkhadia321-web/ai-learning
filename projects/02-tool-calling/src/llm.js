/**
 * A minimal non-streaming chat client.
 *
 * Project 01 streamed responses because we wanted text on screen fast. Here we do the
 * opposite: we WAIT for the whole reply. That's deliberate — when the model's answer is
 * a piece of JSON or a tool request, a half-finished answer is worthless. You can't
 * validate half a JSON object or execute half a function call.
 *
 * Rule of thumb: stream PROSE (a human reads it as it arrives), buffer STRUCTURE
 * (your code needs all of it before it can do anything).
 */

const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_TOOL_MODEL',
    // Small models are bad at tool calling — they invent tool names and mangle
    // arguments. Tool use is a genuine capability difference, not a prompt trick.
    //
    // Model IDs rotate constantly — providers retire them with little notice, and a
    // hardcoded ID becomes a 404 months later. List what's actually available with:
    //   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
    fallbackModel: 'openai/gpt-oss-120b',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    fallbackModel: 'gemini-2.0-flash',
  },
};

export class LlmError extends Error {
  constructor(status, body) {
    super(`LLM call failed (${status}): ${String(body).slice(0, 400)}`);
    this.name = 'LlmError';
    this.status = status;
  }
}

/**
 * @param {object} args
 * @param {'groq'|'google'} [args.provider]
 * @param {string} [args.model]
 * @param {Array<object>} args.messages
 * @param {Array<object>} [args.tools]         Tool definitions the model may request.
 * @param {'auto'|'none'|'required'} [args.toolChoice]
 * @param {object} [args.responseFormat]       e.g. { type: 'json_object' }
 * @param {number} [args.temperature]
 * @param {AbortSignal} [args.signal]
 */
export async function chat({
  provider = 'groq',
  model,
  messages,
  tools,
  toolChoice,
  responseFormat,
  // TEMPERATURE 0 for anything structured.
  //
  // Temperature controls randomness in word choice. For creative prose, some
  // randomness is good. For "extract these five fields" or "pick the right tool", it
  // is pure downside: the same input should give the same output, and randomness
  // just means occasionally picking a slightly worse token that derails the JSON.
  temperature = 0,
  signal,
} = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${cfg.apiKeyEnv} is not set in .env. Project 02 needs a real model — a mock ` +
        `cannot decide which tool to call. Free key: https://console.groq.com/keys`,
    );
  }

  const body = {
    model: model || process.env[cfg.modelEnv] || cfg.fallbackModel,
    messages,
    temperature,
  };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new LlmError(res.status, await res.text().catch(() => ''));

  const data = await res.json();
  return {
    message: data.choices?.[0]?.message ?? {},
    finishReason: data.choices?.[0]?.finish_reason,
    // Always carry usage through. In project 03 this becomes cost accounting; for now
    // it's how you notice that a "simple" agent question cost you 8,000 tokens.
    usage: data.usage ?? null,
    model: data.model,
  };
}
