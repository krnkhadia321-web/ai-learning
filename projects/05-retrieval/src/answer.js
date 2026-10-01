import { z } from 'zod';
import { chat } from './llm.js';
import { hybridSearch } from './retrieve.js';

/**
 * GROUNDED ANSWERING — "nothing outside the document".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PROMPT IS NOT ENOUGH
 *
 * Every RAG tutorial says: put "only answer from the context" in the system prompt.
 * That is a REQUEST, not a control — the same mistake as project 02's "only show the
 * user their own orders", which a user could talk the model out of in one sentence.
 *
 * The model has read most of the internet. Ask it about annual leave and it has
 * opinions regardless of what your document says. The failure mode is identical to
 * project 03's clock: a fluent, confident, plausible answer, HTTP 200, no error — and
 * it came from training data rather than from your PDF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR MECHANISMS THAT ACTUALLY WORK
 *
 *   1. RETRIEVAL GATE   if nothing retrieved scores well enough, refuse BEFORE
 *                       calling the model at all. No context, no opportunity to
 *                       improvise, and no tokens spent.
 *
 *   2. STRUCTURED ANSWER   the model must return JSON with `sufficient_context`,
 *                       so "I can't answer this from the document" is a first-class
 *                       result rather than something you hope the prose contains.
 *
 *   3. MANDATORY CITATIONS   every answer must name the chunks it used. Your code
 *                       then CHECKS those chunk ids were actually in the context —
 *                       a cited id we never supplied means it invented the citation.
 *
 *   4. SUPPORT CHECK    verify the cited passages actually contain the answer's key
 *                       facts. Catches the subtle case: real citation, real passage,
 *                       claim not in it.
 *
 * Mechanisms 1 and 3 are code. The model cannot talk its way past either.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// The gate. Below this best-similarity, we don't even ask.
//
// Tuning this is the same trade as project 04's cache threshold, with the opposite
// failure modes: too high and you refuse questions the document does answer; too low
// and you hand the model irrelevant context, which is an invitation to improvise.
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.25);

// How many chunks to put in front of the model.
const TOP_K = Number(process.env.ANSWER_TOP_K ?? 5);

const AnswerSchema = z.object({
  // Checked FIRST. If the model says the context is insufficient, we don't care what
  // else it produced — we refuse.
  sufficient_context: z.boolean(),
  answer: z.string(),
  // Which numbered passages it used. Validated against what we actually supplied.
  citations: z.array(z.number().int()).default([]),
});

const SYSTEM_PROMPT = `You answer questions using ONLY the numbered passages provided.

Rules:
- Use only information stated in the passages. Never use outside knowledge.
- If the passages do not contain the answer, set "sufficient_context" to false and put
  a brief explanation of what is missing in "answer".
- Partial information is insufficient. If the passages nearly answer the question but
  omit the specific detail asked for, that is false.
- Cite the passage numbers you used in "citations".
- Do not hedge or add caveats drawn from general knowledge.

Respond with JSON only:
{"sufficient_context": true|false, "answer": "...", "citations": [1,2]}`;

function buildContext(chunks) {
  return chunks
    .map((c, i) => `[Passage ${i + 1}] (page ${c.page})\n${c.text}`)
    .join('\n\n---\n\n');
}

/**
 * The refusal we return without calling the model at all.
 */
function refuse(reason, detail, extra = {}) {
  return {
    grounded: false,
    refused: true,
    answer:
      "I can't answer that from this document. " +
      (detail ?? 'Nothing in it is relevant enough to the question.'),
    reason,
    citations: [],
    costUsd: 0,
    ...extra,
  };
}

export async function answerQuestion({ question, documentId, signal }) {
  const startedAt = Date.now();

  // ── Retrieve ────────────────────────────────────────────────────────────────
  const retrieved = await hybridSearch({ query: question, documentId, limit: TOP_K });

  if (retrieved.length === 0) {
    return refuse('no_results', 'The search returned nothing at all.', {
      retrieved: [],
      latencyMs: Date.now() - startedAt,
    });
  }

  // ── MECHANISM 1: the retrieval gate ─────────────────────────────────────────
  //
  // Use the best SEMANTIC similarity, not the RRF score. RRF is a fusion rank — its
  // absolute value says nothing about whether anything is actually relevant, only
  // about relative ordering within this one query's results. A completely irrelevant
  // question still produces a top-ranked chunk; it just has a terrible similarity.
  const best = retrieved.reduce(
    (max, r) => (r.similarity !== null && r.similarity > max ? r.similarity : max),
    -1,
  );

  if (best < MIN_SIMILARITY) {
    return refuse(
      'below_similarity_gate',
      `The closest passage scored ${best.toFixed(3)}, below the ${MIN_SIMILARITY} relevance threshold.`,
      {
        bestSimilarity: best,
        retrieved: retrieved.map(summarise),
        latencyMs: Date.now() - startedAt,
        // Worth being explicit: no model call happened, so this refusal is free.
        gatedBeforeModel: true,
      },
    );
  }

  // ── Ask ─────────────────────────────────────────────────────────────────────
  const result = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${buildContext(retrieved)}\n\n---\n\nQuestion: ${question}`,
      },
    ],
    responseFormat: { type: 'json_object' },
    signal,
  });

  // ── MECHANISM 2: structured answer ──────────────────────────────────────────
  let parsed;
  try {
    parsed = AnswerSchema.parse(JSON.parse(stripFences(result.message.content ?? '')));
  } catch (err) {
    // Malformed output is a failure, not something to paper over. We refuse rather
    // than hand back prose we couldn't validate.
    return refuse('invalid_model_output', `The model's reply did not parse: ${err.message}`, {
      raw: result.message.content?.slice(0, 400),
      costUsd: result.cost.usd,
      retrieved: retrieved.map(summarise),
      latencyMs: Date.now() - startedAt,
    });
  }

  if (!parsed.sufficient_context) {
    return {
      grounded: false,
      refused: true,
      answer: parsed.answer || "I can't answer that from this document.",
      reason: 'model_said_insufficient',
      citations: [],
      retrieved: retrieved.map(summarise),
      costUsd: result.cost.usd,
      latencyMs: Date.now() - startedAt,
    };
  }

  // ── MECHANISM 3: validate the citations ─────────────────────────────────────
  //
  // The model returns passage NUMBERS (1-based, as we labelled them). Anything
  // outside that range was invented — which is a strong signal the answer was too.
  const valid = [];
  const invalid = [];
  for (const n of parsed.citations) {
    if (n >= 1 && n <= retrieved.length) valid.push(n);
    else invalid.push(n);
  }

  const citations = valid.map((n) => ({
    passage: n,
    page: retrieved[n - 1].page,
    text: retrieved[n - 1].text,
  }));

  // An answer claiming sufficient context but citing nothing is unverifiable. Treat
  // it as ungrounded — not because it's necessarily wrong, but because we cannot
  // check it, and unverifiable is the whole thing we're trying to eliminate.
  if (citations.length === 0) {
    return {
      grounded: false,
      refused: false,
      answer: parsed.answer,
      reason: 'no_valid_citations',
      warning:
        'The model answered but cited no valid passage, so the claim cannot be traced ' +
        'back to the document.',
      citations: [],
      invalidCitations: invalid,
      retrieved: retrieved.map(summarise),
      costUsd: result.cost.usd,
      latencyMs: Date.now() - startedAt,
    };
  }

  // ── MECHANISM 4: does the cited text actually support the answer? ────────────
  const support = checkSupport(parsed.answer, citations);

  return {
    grounded: true,
    refused: false,
    answer: parsed.answer,
    citations,
    invalidCitations: invalid,
    support,
    bestSimilarity: best,
    retrieved: retrieved.map(summarise),
    costUsd: result.cost.usd,
    tokens: (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * A cheap, deterministic support check.
 *
 * Pull the "hard" facts out of the answer — numbers, codes, times — and verify each
 * appears in a cited passage. Numbers are where hallucination hurts most and where
 * it's easiest to catch: "22 days" versus "28 days" is a one-token difference with
 * completely different consequences.
 *
 * ⚠️ HONEST LIMITS. This is a heuristic, not proof:
 *   - it cannot check a paraphrased claim with no numbers in it
 *   - a number can appear in the passage while meaning something else entirely
 *   - it says nothing about whether the answer is a fair summary
 *
 * Proper groundedness scoring uses a judge model over (claim, passage) pairs — which
 * is project 06. This catches the blatant cases for free, on every request.
 */
function checkSupport(answer, citations) {
  const cited = citations.map((c) => c.text).join(' ').toLowerCase();

  const facts = [
    ...new Set(
      [
        ...(answer.match(/\b\d[\d,.:]*\b/g) ?? []), // numbers, times, amounts
        ...(answer.match(/\b[A-Z]{2,}-\d+\b/g) ?? []), // codes like SEC-0001
      ].map((f) => f.toLowerCase().replace(/[.,]$/, '')),
    ),
  ];

  const unsupported = facts.filter((f) => !cited.includes(f));

  return {
    checkedFacts: facts.length,
    unsupported,
    // No numeric facts to check is not evidence of support — say so rather than
    // reporting a cheerful "all good".
    verdict:
      facts.length === 0
        ? 'no_checkable_facts'
        : unsupported.length === 0
          ? 'all_facts_appear_in_citations'
          : 'some_facts_not_found_in_citations',
  };
}

const summarise = (c) => ({
  id: c.id,
  page: c.page,
  similarity: c.similarity,
  foundBy: c.foundBy,
  rrfScore: c.rrfScore,
  preview: c.text.replace(/\s+/g, ' ').slice(0, 140),
});

/** Models wrap JSON in markdown fences out of habit, whatever the prompt says. */
function stripFences(text) {
  const m = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : text.trim();
}

export const answerConfig = { MIN_SIMILARITY, TOP_K };
