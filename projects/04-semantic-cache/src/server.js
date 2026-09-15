import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as cache from './cache.js';
import * as budget from './budget.js';
import { routedChat, breakEven, MODELS } from './router.js';
import { runAgent } from './agent.js';
import { warmUp } from './embeddings.js';

const PORT = Number(process.env.PORT_04 ?? 8790);

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
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        redis: cache.isConnected(),
        models: MODELS,
        breakEven: breakEven(),
      });
    }

    // ── THE FULL PIPELINE ────────────────────────────────────────────────────
    //
    //   budget check  →  cache lookup  →  model call  →  record spend  →  store
    //
    // Order matters. The budget check is first because it's the cheapest thing that
    // can reject a request. The cache comes before the model because a hit costs
    // nothing at all — no tokens, no spend, ~20ms for the embedding.
    if (req.method === 'POST' && url.pathname === '/v1/ask') {
      const body = await readJsonBody(req);
      const { question, userId = 'u_1' } = body;
      if (!question) return json(res, 400, { error: '`question` is required' });

      const startedAt = Date.now();

      // 1. Can they afford it?
      const allowance = await budget.check(userId);
      if (!allowance.allowed) {
        // 429 rather than 403: this is a rate limit, and it resets.
        return json(res, 429, { error: allowance.reason, budget: allowance });
      }

      // 2. Have we answered this before?
      const cached = await cache.lookup({ question, userId });
      if (cached.hit) {
        return json(res, 200, {
          answer: cached.answer,
          source: 'cache',
          costUsd: 0,
          savedUsd: null, // unknowable — we never made the call we avoided
          similarity: Number(cached.score.toFixed(4)),
          matchedQuestion: cached.matchedQuestion,
          cachedAt: cached.cachedAt,
          latencyMs: Date.now() - startedAt,
        });
      }

      // 3. Actually answer it.
      const result = await runAgent({ question, model: MODELS.CHEAP, userId });

      // 4. Record what it cost — always, even if storing fails.
      await budget.record(userId, result.costUsd);

      // 5. Store it, if the guards allow.
      const stored = await cache.store({
        question,
        answer: result.answer,
        userId,
        toolsUsed: result.toolsUsed,
      });

      return json(res, 200, {
        answer: result.answer,
        source: 'model',
        costUsd: result.costUsd,
        tokens: result.tokens,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
        cacheMissReason: cached.reason,
        // When the identifier guard blocks a high-scoring match, say so loudly. This
        // is the single most instructive output in the project.
        blockedMatch: cached.blocked ?? null,
        blockedNote: cached.note ?? null,
        cacheStored: stored.stored,
        cacheSkipReason: stored.reason ?? null,
        cacheSkipNote: stored.note ?? null,
        latencyMs: Date.now() - startedAt,
      });
    }

    // ── ROUTING, isolated so you can compare paths on the same question ──────
    if (req.method === 'POST' && url.pathname === '/v1/route') {
      const body = await readJsonBody(req);
      const { question, userId = 'u_1', force } = body;
      if (!question) return json(res, 400, { error: '`question` is required' });

      const allowance = await budget.check(userId);
      if (!allowance.allowed) return json(res, 429, { error: allowance.reason });

      const result = await routedChat({ question, force });
      await budget.record(userId, result.costUsd);

      return json(res, 200, { ...result, breakEven: breakEven() });
    }

    // ── Inspection endpoints ─────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/v1/cache') {
      const userId = url.searchParams.get('userId') ?? 'u_1';
      return json(res, 200, {
        stats: cache.getStats(),
        entries: await cache.listEntries(userId),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/cache/clear') {
      const { userId = 'u_1' } = await readJsonBody(req);
      const removed = await cache.clear(userId);
      cache.resetStats();
      return json(res, 200, { ok: true, removed });
    }

    if (req.method === 'GET' && url.pathname === '/v1/budget') {
      return json(res, 200, await budget.status(url.searchParams.get('userId') ?? 'u_1'));
    }

    if (req.method === 'POST' && url.pathname === '/v1/budget/reset') {
      const { userId = 'u_1' } = await readJsonBody(req);
      await budget.reset(userId);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, async () => {
  console.log(`▸ semantic cache server on http://localhost:${PORT}`);

  try {
    await cache.connect();
    await budget.connect();
  } catch {
    console.warn(
      `\n  ⚠  Redis unreachable at ${process.env.REDIS_URL ?? 'redis://localhost:6379'}\n` +
        `     Start it with:  npm run redis:up --workspace=04-semantic-cache\n` +
        `     The server still runs — caching and budgets are simply disabled.\n`,
    );
  }

  // Load the embedding model now rather than on the first request, which would
  // otherwise pay a ~5 second penalty and look like the cache is slow.
  await warmUp();

  const be = breakEven();
  if (be) console.log(`▸ routing break-even: escalation must stay under ${Math.round(be.maxEscalationRate * 100)}%`);
});

const shutdown = async () => {
  await cache.disconnect().catch(() => {});
  await budget.disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
