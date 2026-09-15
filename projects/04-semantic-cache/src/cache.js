import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { embed, cosine } from './embeddings.js';

/**
 * A SEMANTIC CACHE — and, more importantly, the guards that stop it being dangerous.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IDEA
 *
 * An ordinary cache is keyed on the exact string. "Where is my order?" and "Has my
 * package shipped?" are different strings, so an ordinary cache never connects them —
 * you pay for the model twice.
 *
 * A semantic cache keys on MEANING instead: embed the question, and look for a
 * previous question whose embedding is close by.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THAT IS DANGEROUS — measured, with this model
 *
 *   SAFE   0.508   "What is your return policy?"   vs  "How do I return an item?"
 *   SAFE   0.619   "Do you ship internationally?"  vs  "Can you deliver abroad?"
 *   SAFE   0.652   "How long does shipping take?"  vs  "What are your delivery times?"
 *   SAFE   0.938   "What is the capital of France?" vs "Which city is France's capital?"
 *
 *   DANGER 0.623   "How do I get a refund?"        vs  "How long do refunds take?"
 *   DANGER 0.647   "Is order A-1001 shipped?"      vs  "Is order A-2007 shipped?"
 *   DANGER 0.839   "Can I cancel my order?"        vs  "Did I cancel my order?"
 *   DANGER 0.962   "Where is my order A-1001?"     vs  "Where is my order A-1002?"
 *
 * Read those ranges again. SAFE spans 0.51–0.94. DANGER spans 0.62–0.96. They overlap
 * almost completely, and the single most dangerous pair scores the HIGHEST of all.
 *
 * **There is no threshold that separates them.** A cache built on similarity alone
 * will serve one customer another customer's order status — confidently, with no
 * error, and with a lovely cost saving on the dashboard.
 *
 * So similarity is necessary but never sufficient. Three guards do the real work.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Deliberately high. Given the overlap above, a conservative threshold trades hit rate
// for safety — and that is the correct trade. See NOTES.md: a semantic cache tuned
// safely has a LOW hit rate, and most "we cut costs 40%" claims are either measuring a
// very repetitive workload or quietly serving wrong answers.
const THRESHOLD = Number(process.env.CACHE_THRESHOLD ?? 0.85);

const TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 3600);

// We compare against every entry in a namespace (see findSimilar). Bounding the set
// keeps that honest.
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 500);

let client = null;

export async function connect() {
  if (client?.isReady) return client;

  client = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 2000,
      // WITHOUT THIS the client retries forever, `connect()` never rejects, and the
      // server reports Redis as up while every command fails with an empty error.
      // Failing fast and degrading loudly beats retrying silently.
      reconnectStrategy: false,
    },
  });

  // Errors arrive here even when a command isn't in flight. Some carry no message at
  // all, hence the fallback — logging a blank line is worse than useless.
  client.on('error', (err) => {
    if (!suppressErrors) console.error('[redis]', err?.message || err?.code || 'connection error');
  });

  await client.connect();
  console.log(`▸ redis connected: ${REDIS_URL}`);
  return client;
}

let suppressErrors = false;

/**
 * `isOpen` is true as soon as a connection is *attempted*; `isReady` is true only once
 * the handshake has completed and commands will actually work. Checking the wrong one
 * is why the health endpoint claimed Redis was up while nothing worked.
 */
export const isConnected = () => Boolean(client?.isReady);
export async function disconnect() {
  suppressErrors = true;
  if (client?.isOpen) await client.quit().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 1 — THE IDENTIFIER GUARD
//
// This is what kills the 0.962 case. "Where is my order A-1001?" and "Where is my
// order A-1002?" differ by one character, so they embed almost identically — but the
// correct answers are completely different.
//
// Fix: pull every identifier-shaped token out of both questions. If the sets differ at
// all, it is a MISS regardless of how high the similarity score is. No threshold
// involved; the score does not get a vote.
//
// Also catches "your top 5 products" vs "your top 10 products", which embeds at ~0.95
// and has a different answer.
// ─────────────────────────────────────────────────────────────────────────────
const ID_PATTERNS = [
  /\b[A-Za-z]{1,4}-\d{3,}\b/g, // order-style codes: A-1001, SKU-4472
  /\b\d[\d,.]*\b/g, // any number: quantities, prices, "top 5", years
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, // emails
  /"([^"]{1,60})"/g, // anything the user quoted explicitly
];

export function extractIdentifiers(text) {
  const found = new Set();
  for (const re of ID_PATTERNS) {
    for (const m of text.matchAll(re)) found.add(m[0].toLowerCase());
  }
  return [...found].sort();
}

const sameIdentifiers = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — NEVER CACHE A TOOL-DERIVED ANSWER
//
// The elegant one, and it reaches back to project 03.
//
// If answering required a tool, the answer came from LIVE DATA — an order status, a
// price, the current time. Caching it means serving a stale fact, and if the tool was
// scoped to a user, serving THEIR fact to someone else.
//
// If the model answered with no tools, it answered from general knowledge: a policy,
// a definition, a fact about the world. That is static and safe to cache.
//
// So `toolsUsed.length > 0` is a far better cacheability signal than anything in the
// question text — and it also disposes of "Can I cancel my order?" (policy, no tools,
// cacheable) versus "Did I cancel my order?" (needs a tool, never cached), which
// embed at 0.839 and would otherwise collide.
// ─────────────────────────────────────────────────────────────────────────────
export const isCacheable = (toolsUsed = []) => toolsUsed.length === 0;

// GUARD 3 — namespace by user, so even a false hit cannot cross between accounts.
const nsKey = (userId) => `cache:ns:${userId ?? 'anon'}`;
const entryKey = (userId, id) => `cache:e:${userId ?? 'anon'}:${id}`;

const stats = {
  lookups: 0,
  hits: 0,
  misses: 0,
  blockedByIdentifier: 0,
  belowThreshold: 0,
  notCacheable: 0,
  stored: 0,
};
export const getStats = () => ({ ...stats, threshold: THRESHOLD, ttlSeconds: TTL_SECONDS });
export const resetStats = () => Object.keys(stats).forEach((k) => (stats[k] = 0));

/**
 * Look for a cached answer to this question.
 *
 * @returns {Promise<{hit: boolean, ...}>} always includes `reason` so the UI can show
 *   WHY something missed — a cache you can't explain is a cache you can't trust.
 */
export async function lookup({ question, userId }) {
  stats.lookups++;
  if (!isConnected()) return { hit: false, reason: 'redis not connected' };

  const ids = await client.sMembers(nsKey(userId));
  if (ids.length === 0) {
    stats.misses++;
    return { hit: false, reason: 'cache empty' };
  }

  const queryVec = await embed(question);
  const queryIds = extractIdentifiers(question);

  let best = null;
  let bestBlocked = null;

  for (const id of ids) {
    const raw = await client.hGetAll(entryKey(userId, id));
    // Entry expired out from under the index — tidy up the dangling id.
    if (!raw?.embedding) {
      await client.sRem(nsKey(userId), id);
      continue;
    }

    const score = cosine(queryVec, JSON.parse(raw.embedding));
    if (score < THRESHOLD) continue;

    // Score is high enough. Now the guard gets a veto.
    const entryIds = JSON.parse(raw.identifiers ?? '[]');
    if (!sameIdentifiers(queryIds, entryIds)) {
      // Track the near-misses we blocked — this is the number that proves the guard
      // is earning its place, and it is the headline metric of this project.
      if (!bestBlocked || score > bestBlocked.score) {
        bestBlocked = { score, question: raw.question, identifiers: entryIds };
      }
      continue;
    }

    if (!best || score > best.score) best = { id, score, raw };
  }

  if (!best) {
    if (bestBlocked) {
      stats.blockedByIdentifier++;
      stats.misses++;
      return {
        hit: false,
        reason: 'identifier guard',
        blocked: bestBlocked,
        note:
          `Similarity was ${bestBlocked.score.toFixed(3)} — above the ${THRESHOLD} threshold — ` +
          `but the identifiers differ, so this would have been a WRONG answer.`,
      };
    }
    stats.belowThreshold++;
    stats.misses++;
    return { hit: false, reason: `no entry above threshold ${THRESHOLD}` };
  }

  stats.hits++;
  return {
    hit: true,
    answer: best.raw.answer,
    score: best.score,
    // Always surface what we matched against. If the cache is ever wrong, this is the
    // line that makes it obvious instead of invisible.
    matchedQuestion: best.raw.question,
    cachedAt: best.raw.createdAt,
  };
}

/**
 * Store an answer — if it is safe to.
 */
export async function store({ question, answer, userId, toolsUsed = [] }) {
  if (!isConnected()) return { stored: false, reason: 'redis not connected' };

  if (!isCacheable(toolsUsed)) {
    stats.notCacheable++;
    return {
      stored: false,
      reason: 'tool-derived answer',
      note: `Used ${toolsUsed.join(', ')} — live data, so caching it would serve a stale or another user's fact.`,
    };
  }

  const id = randomUUID();
  const vec = await embed(question);

  await client.hSet(entryKey(userId, id), {
    question,
    answer,
    embedding: JSON.stringify(vec),
    identifiers: JSON.stringify(extractIdentifiers(question)),
    createdAt: new Date().toISOString(),
  });
  // TTL on the entry. Even a "static" answer goes stale — policies change.
  await client.expire(entryKey(userId, id), TTL_SECONDS);
  await client.sAdd(nsKey(userId), id);

  // Keep the namespace bounded. Without this the set grows forever and every lookup
  // gets slower, because of the O(n) scan noted below.
  const size = await client.sCard(nsKey(userId));
  if (size > MAX_ENTRIES) {
    const [oldest] = await client.sRandMember(nsKey(userId), 1);
    if (oldest) {
      await client.del(entryKey(userId, oldest));
      await client.sRem(nsKey(userId), oldest);
    }
  }

  stats.stored++;
  return { stored: true, id };
}

export async function clear(userId) {
  if (!isConnected()) return 0;
  const ids = await client.sMembers(nsKey(userId));
  if (ids.length) await client.del(ids.map((id) => entryKey(userId, id)));
  await client.del(nsKey(userId));
  return ids.length;
}

export async function listEntries(userId) {
  if (!isConnected()) return [];
  const ids = await client.sMembers(nsKey(userId));
  const out = [];
  for (const id of ids) {
    const raw = await client.hGetAll(entryKey(userId, id));
    if (raw?.question) {
      out.push({
        id,
        question: raw.question,
        answer: raw.answer?.slice(0, 120),
        identifiers: JSON.parse(raw.identifiers ?? '[]'),
        createdAt: raw.createdAt,
      });
    }
  }
  return out;
}

/**
 * ⚠️ HONEST NOTE ON THE SEARCH ABOVE.
 *
 * `lookup` compares the query against EVERY entry in the namespace — an O(n) scan,
 * with a round trip to Redis per entry. At 500 entries that is fine (a few
 * milliseconds); at 500,000 it would be hopeless.
 *
 * Production uses a vector INDEX, which finds approximate nearest neighbours without
 * looking at everything. In Redis that is either vector sets or a RediSearch index:
 *
 *   FT.CREATE idx ON HASH PREFIX 1 cache:e:
 *     SCHEMA embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE
 *
 *   FT.SEARCH idx "*=>[KNN 5 @embedding $vec AS score]" PARAMS 2 vec <bytes>
 *
 * We do it by hand here because the arithmetic IS the lesson — once you've written the
 * loop, an index is just a faster way to run it. Project 05 uses a real index
 * (pgvector HNSW) where the scale actually demands one.
 */
