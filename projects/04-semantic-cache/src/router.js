import { chat, PRICING, computeCost } from './llm.js';

/**
 * MODEL ROUTING — try the cheap model, escalate when it isn't good enough.
 *
 * The hotline version: you have a junior expert (cheap, fast) and a senior one
 * (expensive, better). Ask the junior first. If they can't answer confidently, put the
 * question to the senior.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ ROUTING HAS A BREAK-EVEN POINT, AND PEOPLE SKIP THE ARITHMETIC
 *
 * When you escalate you pay for BOTH calls. So with cheap cost C, expensive cost E,
 * and escalation rate r:
 *
 *      routed cost  =  C + r·E          direct-to-expensive  =  E
 *
 *      routing wins only when   C + r·E < E   →   r < 1 − C/E
 *
 * With our two models the cheap one is half the price, so C/E = 0.5 and routing only
 * pays off if **fewer than 50% of questions escalate**. Above that you are paying a
 * cheap call for nothing, every time, and would have been better off going straight to
 * the good model.
 *
 * This is why the escalation rate is a headline metric here rather than a detail. If
 * you don't measure it, you don't know whether your "cost optimisation" is costing you
 * money — which is a surprisingly common way to lose.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CHEAP = process.env.ROUTER_CHEAP_MODEL ?? 'openai/gpt-oss-20b';
const STRONG = process.env.ROUTER_STRONG_MODEL ?? 'openai/gpt-oss-120b';

/**
 * We ask the cheap model to self-report whether it's confident.
 *
 * ⚠️ Be honest about this: self-reported confidence is **weakly calibrated**. Models
 * are often confidently wrong, which is the whole problem from project 03. It is a
 * useful signal, not a reliable one.
 *
 * Stronger escalation signals, roughly in order of trustworthiness:
 *   1. Your own validation failed (schema, format, a required citation missing)
 *   2. finish_reason === 'length' — the answer was truncated
 *   3. The task needs a tool the cheap model didn't call
 *   4. Self-reported low confidence   ← what we use here, being the simplest to show
 *
 * In a real system you'd combine several. In project 06 you'd measure which of them
 * actually predicts a bad answer, instead of guessing.
 */
const ROUTER_PROMPT = `You are a customer support assistant.

Answer the question directly and concisely.

Then, on the very last line and nothing after it, output exactly one of:
CONFIDENCE: HIGH
CONFIDENCE: LOW

Use LOW if the question is ambiguous, needs information you don't have, requires
multi-step reasoning you're unsure about, or you are guessing any part of the answer.`;

const CONFIDENCE_RE = /CONFIDENCE:\s*(HIGH|LOW)\s*$/i;

function splitConfidence(text = '') {
  const m = text.match(CONFIDENCE_RE);
  return {
    answer: text.replace(CONFIDENCE_RE, '').trim(),
    // If the model didn't follow the format at all, treat that as low confidence —
    // failing to follow a simple instruction is itself evidence it's struggling.
    confidence: m ? m[1].toUpperCase() : 'LOW',
    followedFormat: Boolean(m),
  };
}

/**
 * @returns {Promise<{answer, model, escalated, attempts, costUsd, confidence, trail}>}
 */
export async function routedChat({ question, signal, force }) {
  const trail = [];
  let totalCost = 0;

  // `force` lets the test bench skip routing, so you can compare the same question
  // against each path and see the real numbers rather than trusting the maths above.
  const startModel = force === 'strong' ? STRONG : CHEAP;

  const first = await chat({
    model: startModel,
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: question },
    ],
    signal,
  });

  totalCost += first.cost.usd;
  const parsed = splitConfidence(first.message.content);
  trail.push({
    model: startModel,
    confidence: parsed.confidence,
    followedFormat: parsed.followedFormat,
    costUsd: first.cost.usd,
    tokens: (first.usage?.prompt_tokens ?? 0) + (first.usage?.completion_tokens ?? 0),
  });

  const shouldEscalate =
    force !== 'cheap' &&
    force !== 'strong' &&
    startModel === CHEAP &&
    (parsed.confidence === 'LOW' || first.finishReason === 'length');

  if (!shouldEscalate) {
    return {
      answer: parsed.answer,
      model: startModel,
      escalated: false,
      attempts: 1,
      costUsd: totalCost,
      confidence: parsed.confidence,
      trail,
    };
  }

  // Escalate. Note we re-ask from scratch rather than showing the strong model the
  // cheap model's attempt — a wrong first answer anchors the second one, and you paid
  // for a worse result than asking cleanly.
  const second = await chat({
    model: STRONG,
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: question },
    ],
    signal,
  });

  totalCost += second.cost.usd;
  const strongParsed = splitConfidence(second.message.content);
  trail.push({
    model: STRONG,
    confidence: strongParsed.confidence,
    followedFormat: strongParsed.followedFormat,
    costUsd: second.cost.usd,
    tokens: (second.usage?.prompt_tokens ?? 0) + (second.usage?.completion_tokens ?? 0),
  });

  return {
    answer: strongParsed.answer,
    model: STRONG,
    escalated: true,
    attempts: 2,
    costUsd: totalCost,
    confidence: strongParsed.confidence,
    trail,
  };
}

/** The break-even escalation rate, computed from the actual price table. */
export function breakEven() {
  const c = PRICING[CHEAP];
  const e = PRICING[STRONG];
  if (!c || !e) return null;
  // Compare on a representative shape: mostly input, some output.
  const cost = (r) => (1000 * r.input + 300 * r.output) / 1e6;
  const ratio = cost(c) / cost(e);
  return {
    cheapModel: CHEAP,
    strongModel: STRONG,
    costRatio: Number(ratio.toFixed(3)),
    maxEscalationRate: Number((1 - ratio).toFixed(3)),
    note: `Routing only saves money if fewer than ${Math.round((1 - ratio) * 100)}% of questions escalate.`,
  };
}

export const MODELS = { CHEAP, STRONG };
export { computeCost };
