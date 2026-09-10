/**
 * Upstream LLM clients.
 *
 * Both providers here are called through an OpenAI-COMPATIBLE endpoint. That's a
 * deliberate architectural choice, not laziness: the request/response shape becomes
 * identical, so switching providers is a base-URL change instead of a rewrite. In
 * project 04 this is what makes model routing (cheap model first, escalate on
 * failure) almost free to implement.
 */

/** Thrown when the upstream returns a non-2xx. Carries the status so we can decide retryability. */
export class UpstreamError extends Error {
  constructor(status, body, provider) {
    super(`${provider} returned ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.provider = provider;
  }
}

export class ConnectTimeoutError extends Error {
  constructor(ms) {
    super(`Upstream did not send response headers within ${ms}ms`);
    this.name = 'ConnectTimeoutError';
  }
}

export const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    // Model IDs rotate — providers retire them with little notice. If you get a 404
    // saying the model doesn't exist, list the current ones:
    //   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
    fallbackModel: 'openai/gpt-oss-20b',
  },
  google: {
    // Google exposes an OpenAI-compatible surface alongside its native API.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    fallbackModel: 'gemini-2.0-flash',
  },
};

/**
 * Decide whether a failure is worth retrying.
 *
 * Retry: transient network faults, rate limits, and 5xx.
 * Don't retry: 400 (bad request), 401 (bad key), 404 (bad model) — the same request
 * will fail identically, so retrying just burns your rate limit and adds latency.
 */
export function isRetryable(err) {
  if (err instanceof ConnectTimeoutError) return true;
  if (err instanceof UpstreamError) return err.status === 429 || err.status >= 500;
  // fetch throws TypeError for DNS/TCP/TLS failures.
  if (err?.name === 'TypeError') return true;
  return false;
}

/**
 * Parse an OpenAI-style SSE body into JSON objects.
 *
 * THE BUG THIS AVOIDS: a network chunk has no relationship to a frame boundary. One
 * chunk can be half a `data:` line; another can be three frames at once. Parsing
 * chunk-by-chunk gives you intermittent JSON.parse errors under load that vanish
 * when you try to reproduce them locally on a fast connection.
 *
 * Fix: accumulate into a buffer and only consume complete `\n\n`-terminated frames.
 *
 * @param {ReadableStream<Uint8Array>} body
 */
async function* parseSseFrames(body) {
  // `{ stream: true }` matters: a multi-byte UTF-8 character can be split across
  // chunks too. The decoder holds the partial bytes instead of emitting U+FFFD.
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue; // skip comments and other fields
        const data = line.slice(5).trim();
        if (data === '[DONE]') return; // OpenAI's end-of-stream sentinel
        if (!data) continue;
        yield JSON.parse(data);
      }
    }
  }
}

/**
 * Stream chat completions as plain text deltas.
 *
 * @param {object} args
 * @param {'groq'|'google'|'mock'} args.provider
 * @param {string} [args.model]
 * @param {Array<{role: string, content: string}>} args.messages
 * @param {AbortSignal} args.signal
 * @param {number} args.connectTimeoutMs
 * @param {AbortController} args.controller
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat({
  provider,
  model,
  messages,
  signal,
  controller,
  connectTimeoutMs,
}) {
  if (provider === 'mock') {
    yield* mockStream(messages, signal);
    return;
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${cfg.apiKeyEnv} is not set. Add it to .env, or use provider "mock" to run without keys.`,
    );
  }

  // CONNECT TIMEOUT vs TOTAL TIMEOUT — an important distinction.
  //
  // We must NOT put a total-duration timeout on a streaming request: a legitimately
  // long answer would be killed mid-sentence. What we want to bound is the time to
  // *first response headers*. So: arm a timer, abort if it fires, and disarm it the
  // moment headers arrive. From then on, staleness is the idle watchdog's job
  // (see withIdleTimeout in server.js).
  const connectTimer = setTimeout(() => {
    controller.abort(new ConnectTimeoutError(connectTimeoutMs));
  }, connectTimeoutMs);

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || process.env[cfg.modelEnv] || cfg.fallbackModel,
        messages,
        stream: true,
      }),
      // Passing the signal is what makes cancellation actually reach the network
      // layer and close the TCP connection. Without it, "cancelling" only stops
      // you from reading — the provider keeps generating and keeps billing.
      signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new UpstreamError(res.status, body, provider);
  }

  for await (const event of parseSseFrames(res.body)) {
    // OpenAI-compatible delta shape. `?.` throughout because the final chunk often
    // carries usage/finish_reason with no content at all.
    const text = event.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

/**
 * A fake provider so you can run and understand the gateway with no API keys,
 * and so you can deliberately trigger failure modes.
 *
 * Prompt it with the words "slow", "fail" or "hang" to exercise the timeout,
 * retry and watchdog paths.
 */
async function* mockStream(messages, signal) {
  const prompt = messages.at(-1)?.content?.toLowerCase() ?? '';

  if (prompt.includes('fail')) {
    throw new UpstreamError(503, 'mock upstream is pretending to be down', 'mock');
  }

  if (prompt.includes('hang')) {
    // Emits one token then goes silent forever — exactly the failure mode a total
    // timeout catches badly and an idle watchdog catches well.
    yield 'Thinking';
    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    });
    return;
  }

  const delayMs = prompt.includes('slow') ? 400 : 40;
  const words = `This is a mock response streamed one token at a time so you can watch
Server-Sent Events arrive incrementally without spending a single API call.`.split(/\s+/);

  for (const word of words) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, delayMs));
    yield word + ' ';
  }
}
