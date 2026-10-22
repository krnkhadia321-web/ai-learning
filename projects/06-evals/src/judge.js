import { z } from 'zod';
import { chat } from '../../05-retrieval/src/llm.js';

/**
 * LLM-AS-JUDGE — scoring the things string matching can't.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ READ THIS BEFORE TRUSTING A JUDGE SCORE
 *
 * You are using an LLM to grade an LLM. That is circular, and it is the weakest
 * component in this project. The known failure modes are well documented:
 *
 *   • Self-preference      judges rate their own family's output higher
 *   • Verbosity bias       longer answers score better, regardless of correctness
 *   • Position bias        in comparisons, whichever came first tends to win
 *   • Leniency             "is this supported?" skews yes unless you make it work
 *   • Correlated errors    a judge from the same family shares the same blind spots
 *
 * So four rules, all applied here:
 *
 *   1. Use deterministic checks wherever possible. Recall@k, MRR and string matching
 *      need no judge and cannot be wrong. The judge only does what they can't.
 *   2. Give the judge the NARROWEST possible job. Not "is this a good answer" —
 *      "is this specific sentence supported by this specific passage, yes or no".
 *      Narrow, verifiable questions are where judges are most reliable.
 *   3. Give it the source text. A judge without the passages is just a second
 *      opinion from training data — exactly the thing we're testing against.
 *   4. SPOT-CHECK THE JUDGE. Disagreements between judge and human are the only way
 *      to know whether it works. There's a helper for that at the bottom.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// A stronger model than the one under test, deliberately: a judge that is weaker than
// the system it grades is the blind leading the blind.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'openai/gpt-oss-120b';

const GroundednessSchema = z.object({
  // Each claim judged on its own. Forcing the breakdown stops "it all looks fine",
  // which is what a judge asked for a single overall score tends to produce.
  claims: z.array(
    z.object({
      claim: z.string(),
      supported: z.boolean(),
      // Required when unsupported — an unexplained "no" is unusable, and demanding
      // the quote makes the judge actually look at the passage.
      evidence: z.string().optional(),
    }),
  ),
  verdict: z.enum(['fully_grounded', 'partially_grounded', 'not_grounded']),
});

const GROUNDEDNESS_PROMPT = `You check whether an answer is supported by the passages it cites.

Method:
1. Break the answer into individual factual claims.
2. For each claim, decide if the PASSAGES state it. Not whether it is true in general —
   whether these passages say it.
3. If a claim is supported, quote the words that support it in "evidence".
4. If a claim is not in the passages, supported is false.

Be strict. An answer that is true in the world but not stated in the passages is NOT
supported — that is exactly the failure we are looking for.

Ignore filler ("I hope this helps"). Judge only factual claims.

Respond with JSON only:
{"claims":[{"claim":"...","supported":true,"evidence":"..."}],
 "verdict":"fully_grounded"|"partially_grounded"|"not_grounded"}`;

/**
 * Is every claim in the answer supported by the cited passages?
 *
 * This is the metric that matters most and that string checks cannot do. "28 days"
 * being present proves nothing about whether the surrounding sentence is faithful.
 */
export async function judgeGroundedness({ question, answer, citations, signal }) {
  if (!answer || !citations?.length) {
    return { verdict: 'not_grounded', claims: [], note: 'no answer or no citations to check', costUsd: 0 };
  }

  const passages = citations
    .map((c, i) => `[Passage ${i + 1}] (page ${c.page})\n${c.text}`)
    .join('\n\n---\n\n');

  const result = await chat({
    model: JUDGE_MODEL,
    messages: [
      { role: 'system', content: GROUNDEDNESS_PROMPT },
      { role: 'user', content: `${passages}\n\n---\n\nQuestion: ${question}\n\nAnswer to check: ${answer}` },
    ],
    responseFormat: { type: 'json_object' },
    signal,
  });

  try {
    const parsed = GroundednessSchema.parse(JSON.parse(strip(result.message.content ?? '')));
    const unsupported = parsed.claims.filter((c) => !c.supported);
    return {
      ...parsed,
      unsupportedCount: unsupported.length,
      // Derive the score from the per-claim breakdown rather than trusting the
      // judge's own overall verdict — the arithmetic can't be lenient.
      score: parsed.claims.length
        ? parsed.claims.filter((c) => c.supported).length / parsed.claims.length
        : 0,
      costUsd: result.cost.usd,
    };
  } catch (err) {
    // A judge that returns unparseable output has not scored anything. Say so rather
    // than defaulting to a pass — a silently-failing judge reports green forever.
    return {
      verdict: 'judge_failed',
      claims: [],
      score: null,
      note: `judge output did not parse: ${err.message}`,
      costUsd: result.cost.usd,
    };
  }
}

const RefusalSchema = z.object({
  correct: z.boolean(),
  reasoning: z.string(),
});

const REFUSAL_PROMPT = `You check whether a refusal was correct.

You get a question, the passages the system retrieved, and its refusal message.

Decide: do the passages contain enough to answer the question?
- If they DO, the refusal was wrong (correct: false) — a usable answer was available.
- If they do NOT, the refusal was right (correct: true).

Partial information is not enough. If the passages are about the topic but omit the
specific detail asked for, refusing was correct.

Respond with JSON only: {"correct": true|false, "reasoning": "one sentence"}`;

/**
 * Was a refusal justified?
 *
 * The string checks can't do this one. "Refused" is easy to detect; whether it SHOULD
 * have refused requires reading the passages against the question.
 *
 * This is what measures the false-refusal rate honestly — including cases the golden
 * dataset never anticipated.
 */
export async function judgeRefusal({ question, retrieved, refusalMessage, signal }) {
  const passages = (retrieved ?? [])
    .map((r, i) => `[Passage ${i + 1}] (page ${r.page})\n${r.preview ?? r.text}`)
    .join('\n\n---\n\n');

  const result = await chat({
    model: JUDGE_MODEL,
    messages: [
      { role: 'system', content: REFUSAL_PROMPT },
      {
        role: 'user',
        content: `${passages || '(nothing was retrieved)'}\n\n---\n\nQuestion: ${question}\n\nThe system refused, saying: ${refusalMessage}`,
      },
    ],
    responseFormat: { type: 'json_object' },
    signal,
  });

  try {
    const parsed = RefusalSchema.parse(JSON.parse(strip(result.message.content ?? '')));
    return { ...parsed, costUsd: result.cost.usd };
  } catch (err) {
    return { correct: null, reasoning: `judge output did not parse: ${err.message}`, costUsd: result.cost.usd };
  }
}

function strip(text) {
  const m = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : text.trim();
}

/**
 * ⭐ VALIDATING THE JUDGE ITSELF.
 *
 * The question nobody asks: how do you know the judge is any good?
 *
 * You label a sample by hand and measure agreement. If the judge agrees with you on
 * 95% of 20 cases, its scores mean something. If it agrees on 60%, you are adding
 * expensive noise and would be better off with the string checks alone.
 *
 * Usage: label a handful of cases in `humanLabels` as { id: true|false } and run this
 * against the judge's output. Agreement below ~0.8 means fix the judge prompt before
 * trusting any number it produces.
 */
export function judgeAgreement(humanLabels, judgeResults) {
  const ids = Object.keys(humanLabels);
  if (!ids.length) return null;

  let agree = 0;
  const disagreements = [];

  for (const id of ids) {
    const human = humanLabels[id];
    const judged = judgeResults[id];
    if (judged === undefined || judged === null) continue;
    if (human === judged) agree++;
    else disagreements.push({ id, human, judge: judged });
  }

  return {
    sampleSize: ids.length,
    agreement: agree / ids.length,
    disagreements,
    note:
      agree / ids.length < 0.8
        ? 'Agreement below 0.8 — the judge is not reliable enough to act on. Fix the prompt or the model before trusting its scores.'
        : 'Agreement acceptable.',
  };
}

export const judgeConfig = { JUDGE_MODEL };
