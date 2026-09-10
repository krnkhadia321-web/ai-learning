import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createSseStream } from './sse.js';
import { streamChat, isRetryable, UpstreamError } from './providers.js';

const PORT = Number(process.env.PORT ?? 8787);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 10_000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 20_000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

class IdleTimeoutError extends Error {
  constructor(ms) {
    super(`Upstream stream stalled: no token for ${ms}ms`);
    this.name = 'IdleTimeoutError';
  }
}

/**
 * Wrap an async iterator so that a gap between items longer than `ms` throws.
 *
 * WHY THIS EXISTS: a hung LLM stream does not fail. The TCP connection stays open
 * and healthy, the provider just stops sending tokens. No error surfaces, `for await`
 * blocks forever, and your request handler leaks until the process restarts. This is
 * the single most common way LLM gateways fall over in production.
 *
 * A total-duration timeout is the wrong tool: it can't distinguish a long-but-healthy
 * answer from a stalled one. What you actually care about is time SINCE THE LAST TOKEN.
 */
async function* withIdleTimeout(source, ms) {
  const iterator = source[Symbol.asyncIterator]();

  while (true) {
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new IdleTimeoutError(ms)), ms);
    });

    let result;
    try {
      // Race the next token against the watchdog. Note we abandon the losing
      // promise — the caller aborts the AbortController on this error, which is
      // what actually tears down the underlying request.
      result = await Promise.race([iterator.next(), stalled]);
    } finally {
      clearTimeout(timer);
    }

    if (result.done) return;
    yield result.value;
  }
}

/**
 * Exponential backoff with FULL JITTER.
 *
 * Plain exponential backoff synchronises clients: when a provider rate-limits
 * everyone at once, every client waits the same 1s and retries in the same
 * millisecond, re-creating the spike that caused the problem. Randomising the whole
 * interval spreads the retries out.
 */
function backoffMs(attempt) {
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.random() * ceiling;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read and JSON-parse a request body, with a size cap so a huge POST can't OOM us. */
async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * POST /v1/chat/stream
 * Body: { provider?: 'mock'|'groq'|'google', model?: string, messages: [...] }
 */
async function handleChatStream(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  const { provider = 'mock', model, messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '`messages` must be a non-empty array' }));
    return;
  }

  const sse = createSseStream(req, res);

  // ONE controller for the whole request lifecycle. Everything that should cancel
  // the upstream call — client disconnect, idle watchdog, server shutdown — trips
  // this same switch.
  const controller = new AbortController();

  const startedAt = Date.now();
  let firstTokenAt = null;
  let tokenCount = 0;

  console.log(`[start] provider=${provider} model=${model ?? 'default'}`);

  // THE MONEY LESSON OF THIS PROJECT:
  // When the client disappears, the provider does NOT know or care. It keeps
  // generating tokens and keeps charging for them. Wiring disconnect -> abort is
  // what turns "user closed the tab" into "we stopped paying", and on a free tier
  // it's what stops you burning your quota on output nobody will ever read.
  res.on('close', () => {
    // `close` also fires on normal completion, so distinguish the two: if we ended
    // the response ourselves, the client didn't hang up on us.
    if (res.writableEnded) return;

    controller.abort(new Error('client disconnected'));
    console.warn(
      `[abort] client disconnected after ${tokenCount} chunk(s) / ${Date.now() - startedAt}ms ` +
        `— upstream call cancelled, we stop paying for the rest`,
    );
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const upstream = streamChat({
        provider,
        model,
        messages,
        signal: controller.signal,
        controller,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });

      for await (const delta of withIdleTimeout(upstream, IDLE_TIMEOUT_MS)) {
        if (sse.closed) return; // client left; stop doing work

        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          // Time To First Token is THE latency metric for streaming UIs. Total
          // duration barely matters to perceived speed; TTFT is what the user feels.
          sse.send('start', { ttftMs: firstTokenAt - startedAt, provider, attempt });
        }

        tokenCount++;
        sse.send('delta', { text: delta });
      }

      sse.send('done', {
        tokens: tokenCount,
        ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalMs: Date.now() - startedAt,
      });
      console.log(
        `[done]  ${tokenCount} chunk(s) / ${Date.now() - startedAt}ms ` +
          `(TTFT ${firstTokenAt ? firstTokenAt - startedAt : '—'}ms)`,
      );
      sse.end();
      return;
    } catch (err) {
      if (controller.signal.aborted && sse.closed) return; // client vanished — nothing to report to

      // On idle timeout the fetch is still open. Abort it, or the connection and
      // the provider-side generation both leak.
      if (err instanceof IdleTimeoutError) controller.abort(err);

      // ── THE SUBTLE RULE OF RETRYING A STREAM ──────────────────────────────────
      // Once a single token has reached the client, the response is no longer
      // retryable. A retry starts generation from scratch, so the client would see
      // the first half of answer A followed by all of answer B. There is no way to
      // "un-send" it — the 200 and the bytes are already on the wire.
      //
      // So: retries are only legal BEFORE the first byte. After that, the only
      // honest move is to tell the client the stream broke and let IT decide.
      const canRetry =
        firstTokenAt === null && attempt < MAX_ATTEMPTS && isRetryable(err);

      if (!canRetry) {
        // We already sent HTTP 200 with the headers, so we cannot switch to a 500.
        // The status code is spent. Errors after that point must travel IN-BAND as
        // an SSE event, and the client must be written to expect one.
        sse.send('error', {
          message: err.message,
          type: err.name,
          retryable: isRetryable(err),
          partial: firstTokenAt !== null,
        });
        sse.end();
        return;
      }

      const wait = backoffMs(attempt);
      console.warn(
        `[retry] attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.name}: ${err.message}); retrying in ${Math.round(wait)}ms`,
      );
      await sleep(wait);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/v1/chat/stream') {
    return handleChatStream(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()) }));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const page = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Long-lived streams and the default 5s keep-alive timeout do not mix. Node would
// close idle sockets out from under a model that is still thinking.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0; // no total cap — the idle watchdog is our safety net

server.listen(PORT, () => {
  console.log(`▸ streaming gateway on http://localhost:${PORT}`);
  console.log(`  demo UI:  http://localhost:${PORT}/`);
  console.log(`  provider: mock (no API key needed) | groq | google`);
});
