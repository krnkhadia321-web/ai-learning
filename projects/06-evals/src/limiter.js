/**
 * RATE-LIMIT HANDLING FOR EVAL RUNS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ EVAL SUITES ARE BURSTY IN A WAY NORMAL USAGE NEVER IS.
 *
 * A person clicking around the app sends one request every few seconds. An eval suite
 * sends 17 back to back, each carrying five retrieved passages plus a judge call on
 * top. The first run of this suite died at case 13:
 *
 *   429: Rate limit reached ... tokens per minute (TPM): Limit 8000, Used 7411
 *
 * This is not a bug in the suite. It is what a suite DOES. Any eval harness you build
 * will meet the same wall, and it's worth recognising the shape: the limit is on
 * TOKENS per minute, not requests, so sending fewer-but-fatter calls doesn't help.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two mechanisms, both from project 01's streaming gateway:
 *
 *   1. Retry on 429, honouring the delay the provider tells us
 *   2. Full jitter on the backoff, so parallel runs don't resynchronise
 *
 * Plus one that's specific to batch work: a gap between cases, so we approach the
 * limit gently instead of sprinting into it and recovering.
 */

const MAX_ATTEMPTS = Number(process.env.EVAL_MAX_ATTEMPTS ?? 5);

// A deliberate pause between cases. Cheap insurance: 1.2s × 17 cases adds ~20
// seconds to a run and removes most of the retrying.
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 1200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull the wait time out of a provider's rate-limit error.
 *
 * Groq states it in the message: "Please try again in 3.525s". Honouring the
 * provider's own number beats guessing — it knows when the window resets and we
 * don't, and over-waiting is cheaper than another 429.
 */
function retryAfterMs(err) {
  const m = /try again in ([\d.]+)s/i.exec(err?.message ?? '');
  if (m) return Math.ceil(Number(m[1]) * 1000) + 250; // small cushion
  return null;
}

const isRateLimit = (err) => err?.status === 429 || /rate limit/i.test(err?.message ?? '');

/**
 * Run `fn`, retrying on rate limits.
 *
 * Only 429s are retried. A 400 or a 401 would fail identically every time, so
 * retrying those just burns the limit further — the same rule as project 01.
 */
export async function withRetry(fn, { label = 'call', onRetry } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err) || attempt === MAX_ATTEMPTS) throw err;

      // Prefer what the provider told us; otherwise exponential with FULL JITTER.
      // Jitter matters because without it every retrying client resynchronises and
      // hits the limit together the moment the window opens.
      const wait = retryAfterMs(err) ?? Math.random() * Math.min(1000 * 2 ** (attempt - 1), 30_000);

      onRetry?.(`rate limited on ${label}, waiting ${Math.round(wait)}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }

  throw lastErr;
}

/** A gap between cases so the run approaches the limit rather than sprinting at it. */
export const pace = () => (PACE_MS > 0 ? sleep(PACE_MS) : Promise.resolve());

export const limiterConfig = { MAX_ATTEMPTS, PACE_MS };
