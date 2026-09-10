import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Reusing project 01's SSE writer rather than rewriting it. This is why the ladder is
// one repo: the transport you built for streaming prose is exactly what streams the
// agent's steps here. By the capstone, most of the pieces already exist.
import { createSseStream } from '../../01-streaming-gateway/src/sse.js';

import { extractTicket } from './extract.js';
import { runAgent } from './agent.js';

const PORT = Number(process.env.PORT_02 ?? 8788);

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

  try {
    // ── Structured output: prose in, validated JSON out ─────────────────────────
    // Buffered, not streamed — a half-parsed ticket is useless to the caller.
    if (req.method === 'POST' && url.pathname === '/v1/extract') {
      const { email, provider } = await readJsonBody(req);
      if (!email) return json(res, 400, { error: '`email` is required' });

      const started = Date.now();
      try {
        const { ticket, attempts, trace } = await extractTicket({ email, provider });
        console.log(`[extract] ok in ${attempts} attempt(s), ${Date.now() - started}ms`);
        return json(res, 200, { ticket, attempts, trace });
      } catch (err) {
        console.warn(`[extract] failed: ${err.message}`);
        return json(res, 422, { error: err.message, trace: err.trace ?? null });
      }
    }

    // ── Agent: streams each step of the tool loop as it happens ─────────────────
    if (req.method === 'POST' && url.pathname === '/v1/agent') {
      const { question, provider, userId } = await readJsonBody(req);
      if (!question) return json(res, 400, { error: '`question` is required' });

      const sse = createSseStream(req, res);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort(new Error('client disconnected'));
      });

      console.log(`[agent] "${question}" (user=${userId ?? 'u_1'})`);

      try {
        for await (const event of runAgent({
          question,
          provider,
          userId,
          signal: controller.signal,
        })) {
          if (sse.closed) return;
          console.log(`  ↳ ${event.type}${event.name ? ` ${event.name}` : ''}`);
          sse.send(event.type, event);
        }
      } catch (err) {
        // Same rule as project 01: the 200 is already spent, so errors go in-band.
        sse.send('error', { message: err.message, type: err.name });
      }
      sse.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, hasGroqKey: Boolean(process.env.GROQ_API_KEY) });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;

server.listen(PORT, () => {
  console.log(`▸ tool-calling server on http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.warn(
      `\n  ⚠  No API key found. This project needs a real model — a mock cannot decide\n` +
        `     which tool to call. Add GROQ_API_KEY to .env (free: https://console.groq.com/keys)\n`,
    );
  }
});
