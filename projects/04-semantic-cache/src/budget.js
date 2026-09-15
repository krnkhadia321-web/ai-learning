import { createClient } from 'redis';

/**
 * SPEND-BASED RATE LIMITING.
 *
 * You already know how to rate limit by request count. This is the same pattern with a
 * different counter — and the different counter is the entire point.
 *
 * WHY COUNTING REQUESTS DOESN'T WORK HERE:
 * For a normal API, every request costs about the same, so "100 requests per hour"
 * genuinely bounds what a user can consume. For an LLM, one request can cost a hundred
 * times another — a one-line question versus a six-iteration agent loop resending a
 * growing conversation. A request limit permissive enough to be useful is useless as a
 * spend limit.
 *
 * So you count money.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DAILY_LIMIT_USD = Number(process.env.DAILY_LIMIT_USD ?? 0.01);

let client = null;

export async function connect() {
  if (client?.isReady) return client;
  client = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  // Quiet: cache.js already reports connection problems for the same server.
  client.on('error', () => {});
  await client.connect();
  return client;
}

export async function disconnect() {
  if (client?.isReady) await client.quit();
}

// Key includes the date, so the window resets naturally at midnight UTC and old keys
// expire themselves. No cron job, no cleanup, no "delete rows older than" query.
const key = (userId) =>
  `budget:${userId ?? 'anon'}:${new Date().toISOString().slice(0, 10)}`;

/**
 * Can this user afford another call?
 *
 * ⚠️ THE UNAVOIDABLE PROBLEM: you cannot know what an LLM call costs until it has
 * finished. Token counts only exist in the response. So a true pre-authorisation —
 * the way a card payment reserves funds — is impossible.
 *
 * Three options, and it's worth knowing why we pick the third:
 *
 *   1. Estimate and reserve up front, refund the difference. Accurate, but you need a
 *      good estimate and refund logic, and a crash leaks the reservation.
 *   2. Check the balance before, record the cost after. Simple. A user can overshoot
 *      by at most one call — and by more if they fire many at once.
 *   3. (2) plus a concurrency cap, so the worst-case overshoot is bounded and known.
 *
 * We do (2) here and document the gap, because pretending a limit is exact when it
 * isn't is worse than a limit with a known, stated tolerance.
 */
export async function check(userId) {
  if (!client?.isReady) return { allowed: true, reason: 'budget disabled (no redis)' };

  const spent = Number((await client.get(key(userId))) ?? 0);
  const remaining = DAILY_LIMIT_USD - spent;

  if (remaining <= 0) {
    return {
      allowed: false,
      spent,
      limit: DAILY_LIMIT_USD,
      remaining: 0,
      reason: `Daily limit of $${DAILY_LIMIT_USD} reached (spent $${spent.toFixed(6)}).`,
    };
  }

  return { allowed: true, spent, limit: DAILY_LIMIT_USD, remaining };
}

/**
 * Record what a call actually cost.
 *
 * INCRBYFLOAT is atomic, so concurrent requests can't lose each other's spend the way
 * a read-modify-write would. The check above is still racy — two requests can both
 * pass it before either records — but the *accounting* is never wrong, which is the
 * part that matters for the next request.
 */
export async function record(userId, usd) {
  if (!client?.isReady || !usd) return;
  const k = key(userId);
  await client.incrByFloat(k, usd);
  // Expire two days out: the key is date-stamped so it's dead at midnight anyway,
  // and this just stops yesterday's keys accumulating forever.
  await client.expire(k, 60 * 60 * 48);
}

export async function status(userId) {
  if (!client?.isReady) return { enabled: false };
  const spent = Number((await client.get(key(userId))) ?? 0);
  return {
    enabled: true,
    userId: userId ?? 'anon',
    spent,
    limit: DAILY_LIMIT_USD,
    remaining: Math.max(0, DAILY_LIMIT_USD - spent),
    percentUsed: Math.min(100, Math.round((spent / DAILY_LIMIT_USD) * 100)),
    resetsAt: 'midnight UTC',
  };
}

export async function reset(userId) {
  if (client?.isReady) await client.del(key(userId));
}
