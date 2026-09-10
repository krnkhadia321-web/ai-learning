// ⚠️ MUST BE FIRST. The SDK has to be running before any module creates a tracer,
// or those modules capture a no-op tracer at import time and silently emit nothing.
// "Tracing works everywhere except in one file" is almost always import order.
import './tracing.js';

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SpanKind, context, trace } from '@opentelemetry/api';

import { createSseStream } from '../../01-streaming-gateway/src/sse.js';
import { runAgent } from './agent.js';
import { tracer, usageSummary, resetLedger, failSpan, CAPTURE_MODE } from './genai.js';

const PORT = Number(process.env.PORT_03 ?? 8789);

async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Endpoints with no interesting work: don't trace them ────────────────────
  // Health checks fire every few seconds forever. Tracing them buries your real
  // traces in noise and, on a paid backend, is most of your bill.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, capture: CAPTURE_MODE, tracing: process.env.OTEL_ENABLED === 'true' });
  }

  if (req.method === 'GET' && url.pathname === '/v1/usage') {
    return json(res, 200, usageSummary());
  }

  if (req.method === 'POST' && url.pathname === '/v1/usage/reset') {
    resetLedger();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const page = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  if (req.method === 'POST' && url.pathname === '/v1/agent') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    if (!body.question) return json(res, 400, { error: '`question` is required' });

    // The SERVER span — the root of the whole trace. SpanKind.SERVER means "someone
    // called us"; the LLM spans are SpanKind.CLIENT, "we called someone". Backends
    // use that distinction to draw service maps.
    return tracer.startActiveSpan(
      'POST /v1/agent',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': 'POST',
          'url.path': url.pathname,
          'enduser.id': body.userId ?? 'u_1',
        },
      },
      async (span) => {
        // The trace ID, surfaced to the caller. This is the single most useful
        // debugging affordance you can build: a user reports "it gave me nonsense",
        // quotes the ID, and you open the exact trace. Without it you're searching
        // by timestamp and hoping.
        const traceId = span.spanContext().traceId;
        res.setHeader('X-Trace-Id', traceId);

        const sse = createSseStream(req, res);
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) controller.abort(new Error('client disconnected'));
        });

        sse.send('trace', { traceId, jaeger: `http://localhost:16686/trace/${traceId}` });

        try {
          for await (const event of runAgent({
            question: body.question,
            provider: body.provider,
            userId: body.userId,
            signal: controller.signal,
          })) {
            if (sse.closed) break;
            sse.send(event.type, event);
            if (event.type === 'answer') {
              span.setAttributes({
                'gen_ai.usage.cost_usd': event.costUsd ?? 0,
                'gen_ai.usage.total_tokens': event.totalTokens ?? 0,
              });
            }
          }
        } catch (err) {
          failSpan(span, err);
          sse.send('error', { message: err.message, type: err.name });
        } finally {
          span.end();
          sse.end();
        }
      },
    );
  }

  return json(res, 404, { error: 'Not found' });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;

server.listen(PORT, () => {
  console.log(`▸ observability server on http://localhost:${PORT}`);
  console.log(`  content capture: ${CAPTURE_MODE}  (GENAI_CAPTURE=full|redacted|none)`);
});
