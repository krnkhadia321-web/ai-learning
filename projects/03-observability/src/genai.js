/**
 * GenAI telemetry: cost accounting, redaction, and an in-process ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY LLM OBSERVABILITY IS NOT NORMAL APM
 *
 * Your usual monitoring answers "did it work?" — status codes, error rates, latency,
 * uptime. That works because a normal endpoint either succeeds or fails.
 *
 * An LLM call can succeed PERFECTLY and still be wrong. HTTP 200, no exception,
 * 400ms, fluent well-formatted text — and completely fabricated. Every dashboard you
 * own is green while the product is broken.
 *
 * So LLM telemetry has to record things normal APM never bothers with:
 *   - WHAT was said, not just that a call happened   (quality has no status code)
 *   - how many tokens, in and out                    (this is the unit of cost)
 *   - money, per request and per user                (the only metric that scales
 *                                                     with usage instead of traffic)
 *   - which tools were actually invoked              (project 02: the model answered
 *                                                     a date question WITHOUT calling
 *                                                     the clock — right answer, wrong
 *                                                     process, invisible in the output)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';

export const tracer = trace.getTracer('ai-learning/genai', '1.0.0');

/**
 * OpenTelemetry GenAI semantic-convention attribute names.
 *
 * WHY CONVENTIONS AT ALL: these exact strings are what let a dashboard built for one
 * service work on another, and what lets Grafana / Datadog / Langfuse understand your
 * spans with no custom configuration. Invent `model_name` or `tokens_used` and you get
 * data nothing else can read.
 *
 * WHY LITERALS AND NOT THE SDK CONSTANTS: `@opentelemetry/semantic-conventions`
 * marks its `ATTR_GEN_AI_*` exports deprecated because the GenAI conventions are being
 * moved to a dedicated package — which is not published to npm yet. So the constants
 * are deprecated and their replacement doesn't exist.
 *
 * The resolution is worth internalising: **the attribute STRING is the contract, not
 * the JS constant.** `gen_ai.usage.input_tokens` is what goes on the wire and what
 * every backend matches on. The constant is a typo-guard. When conventions are mid-
 * migration, pinning the strings yourself is correct — and the day the new package
 * ships, swapping to it changes nothing observable.
 *
 * These are still incubating and may change. Check before relying on them long-term:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GENAI = {
  OPERATION: 'gen_ai.operation.name',
  PROVIDER: 'gen_ai.provider.name', // replaced the older `gen_ai.system`
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  TEMPERATURE: 'gen_ai.request.temperature',
  FINISH_REASONS: 'gen_ai.response.finish_reasons',
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
};

// ─────────────────────────────────────────────────────────────────────────────
// PRICING
//
// ⚠️ THESE NUMBERS ARE PLACEHOLDERS. Provider pricing changes constantly and these
//    are not verified. Replace them from your provider's pricing page before you
//    trust any figure this file produces.
//
//    What matters for learning is the MECHANISM, not the constants: cost is
//    (input_tokens × input_rate) + (output_tokens × output_rate), and output tokens
//    are typically several times more expensive than input tokens. That asymmetry
//    drives real design decisions — it's why "be concise" in a system prompt is a
//    cost control, and why retrieval (stuffing more input) is cheaper than you'd think.
// ─────────────────────────────────────────────────────────────────────────────
export const PRICING = {
  // USD per 1,000,000 tokens.
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
  'qwen/qwen3.8-27b': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

const DEFAULT_RATE = { input: 0.1, output: 0.4 };

/** @returns {{ usd: number, rate: object, estimated: boolean }} */
export function computeCost(model, inputTokens = 0, outputTokens = 0) {
  const known = PRICING[model];
  const rate = known ?? DEFAULT_RATE;
  const usd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  // Flagging estimates matters: an unknown model silently priced at a default rate
  // is how cost dashboards drift away from the actual invoice.
  return { usd, rate, estimated: !known };
}

// ─────────────────────────────────────────────────────────────────────────────
// REDACTION
//
// Prompts and completions are the most useful thing to record and the most dangerous.
// They routinely contain names, emails, phone numbers, addresses, card numbers —
// whatever your users typed. Shipping raw prompts to a third-party observability
// vendor is a data-processing decision, not a debugging convenience.
//
// The industry default is: record content in development, redact or sample it in
// production, and never record it at all for regulated data.
// ─────────────────────────────────────────────────────────────────────────────

// ORDER IS LOAD-BEARING. These run in sequence, and the first match wins.
//
// A 16-digit card number also matches a "long run of digits" phone pattern, so if
// phone runs first every card is mislabelled `[phone]`. Always order most-specific
// to least-specific, and put the longest digit runs first.
//
// ⚠️ And be honest about what this is: regex redaction is BEST-EFFORT, not a
// compliance control. It won't catch a name, an address, an account number in an
// unusual format, or anything a user phrases unexpectedly. For regulated data the
// answer is GENAI_CAPTURE=none — don't record content at all.
const PATTERNS = [
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[email]'],
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[card]'], // 13–19 digits — cards, before phones
  [/\+?\d(?:[ -]?\d){7,13}\b/g, '[phone]'], // 8–14 digits, keeps the leading +
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[pan]'], // Indian PAN
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, tag] of PATTERNS) out = out.replace(re, tag);
  return out;
}

/**
 * Should we attach message content to spans at all?
 *
 * Three modes rather than a boolean, because the honest answer differs by environment:
 *   full     — record everything (local development)
 *   redacted — record with PII patterns stripped (default; useful and defensible)
 *   none     — record only metadata: token counts, latency, model, tool names
 */
export const CAPTURE_MODE = process.env.GENAI_CAPTURE ?? 'redacted';

export function captureContent(span, key, value) {
  if (CAPTURE_MODE === 'none') return;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return;
  // Truncate. A span carrying a 100 KB prompt will be dropped by collectors with
  // size limits, and you'll lose the whole trace rather than just the big attribute.
  const capped = text.length > 4000 ? `${text.slice(0, 4000)}…[truncated]` : text;
  span.setAttribute(key, CAPTURE_MODE === 'full' ? capped : redact(capped));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LEDGER
//
// An in-process record of every model call, always on and independent of Jaeger.
//
// Why bother when we have traces? Because tracing answers "what happened in THIS
// request" and the ledger answers "what is this costing me across all requests".
// Those are different questions and, in a real system, different tools — traces in
// Jaeger/Tempo, aggregates in Prometheus or a warehouse.
//
// In-memory and bounded, so it's a teaching aid, not a billing system. A real one
// writes to a database you can query historically.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RECORDS = 500;
const records = [];

export function recordCall(entry) {
  records.push({ at: new Date().toISOString(), ...entry });
  if (records.length > MAX_RECORDS) records.shift();
}

export function usageSummary() {
  const total = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  const byModel = {};
  const byUser = {};
  const byOperation = {};

  for (const r of records) {
    total.calls++;
    total.inputTokens += r.inputTokens ?? 0;
    total.outputTokens += r.outputTokens ?? 0;
    total.usd += r.usd ?? 0;

    for (const [bucket, key] of [
      [byModel, r.model],
      [byUser, r.userId],
      [byOperation, r.operation],
    ]) {
      if (!key) continue;
      bucket[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
      bucket[key].calls++;
      bucket[key].inputTokens += r.inputTokens ?? 0;
      bucket[key].outputTokens += r.outputTokens ?? 0;
      bucket[key].usd += r.usd ?? 0;
    }
  }

  return {
    total: { ...total, usd: round(total.usd) },
    byModel: roundAll(byModel),
    byUser: roundAll(byUser),
    byOperation: roundAll(byOperation),
    // The ratio that surprises people. See NOTES.md §6.
    outputShareOfCost: total.usd
      ? round(records.reduce((s, r) => s + (r.outputUsd ?? 0), 0) / total.usd)
      : 0,
    recent: records.slice(-20).reverse(),
  };
}

export function resetLedger() {
  records.length = 0;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const roundAll = (obj) => {
  for (const v of Object.values(obj)) v.usd = round(v.usd);
  return obj;
};

/** Mark a span as failed. Without this, an errored span still looks green in the UI. */
export function failSpan(span, err) {
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}
