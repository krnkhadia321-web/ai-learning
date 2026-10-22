/**
 * METRICS — scoring one eval case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE CENTRAL RULE: SCORE RETRIEVAL AND ANSWERING SEPARATELY. NEVER BLEND THEM.
 *
 * Project 05 proved they fail independently. The multi-hop case is the proof:
 *
 *     retrieval  ❌  page 35 was never retrieved
 *     answering  ✅  given only software passages, it refused rather than inventing
 *
 * A single "accuracy: 60%" number would hide that completely — and the two have
 * completely different fixes. Bad retrieval → chunking, query handling, reranking.
 * Bad answering → the prompt, the model, the output contract.
 *
 * From the final answer alone, "the document doesn't say that" and "we failed to find
 * where the document says it" are indistinguishable. Only separate scores tell you.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// RETRIEVAL METRICS — deterministic, no LLM, free, instant
//
// Do as much as possible here. A judge model is slow, costs money, and can be wrong;
// "was page 35 in the results?" is none of those things.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recall@k — did we retrieve at least one page we expected?
 *
 * The most important retrieval metric for RAG, because the generator cannot use what
 * it never received. Recall is the ceiling on everything downstream.
 */
export function recallAtK(retrievedPages, expectedPages) {
  if (!expectedPages?.length) return null; // nothing claimed, nothing to score
  const found = expectedPages.filter((p) => retrievedPages.includes(p));
  return {
    hit: found.length > 0,
    found,
    missed: expectedPages.filter((p) => !retrievedPages.includes(p)),
    // Fraction of expected pages retrieved. Matters for multi-hop, where finding
    // one of two is a partial success and "hit" alone would call it a win.
    coverage: found.length / expectedPages.length,
  };
}

/**
 * Mean Reciprocal Rank — HOW HIGH was the first correct page?
 *
 *     rank 1 → 1.00     rank 2 → 0.50     rank 3 → 0.33     not found → 0
 *
 * Recall only asks "was it in the top k at all". MRR rewards getting it to the top,
 * which matters because the generator pays more attention to earlier passages and
 * because a lower k would have missed it.
 *
 * A change that moves the right page from rank 4 to rank 1 is a real improvement that
 * recall@5 scores as identical.
 */
export function reciprocalRank(retrievedPages, expectedPages) {
  if (!expectedPages?.length) return null;
  const idx = retrievedPages.findIndex((p) => expectedPages.includes(p));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// BEHAVIOUR METRICS — did it answer when it should, and refuse when it should?
//
// This is a CONFUSION MATRIX, and the two error types are not equally bad:
//
//                        should ANSWER        should REFUSE
//     answered           ✅ correct           ❌ FALSE ACCEPT   ← may be a hallucination
//     refused            ❌ false refusal     ✅ correct
//
// A false accept risks a confident wrong answer reaching a user.
// A false refusal is annoying but safe.
//
// They trade against each other through MIN_SIMILARITY, which is exactly why a single
// "accuracy" number is useless — see sweep.js.
// ─────────────────────────────────────────────────────────────────────────────

export function classifyBehaviour(expected, actuallyAnswered) {
  if (expected === 'answer') return actuallyAnswered ? 'correct_answer' : 'false_refusal';
  return actuallyAnswered ? 'false_accept' : 'correct_refusal';
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTNESS — cheap string checks before reaching for a judge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ NORMALISE BEFORE COMPARING — a trap this suite walked straight into.
 *
 * The very first run reported this failure:
 *
 *     carry-over-expiry
 *        · answer missing: 31 March
 *        answer: "Carried-over annual leave days expire on 31 March."
 *
 * The answer plainly contains "31 March". The eval was wrong, not the system.
 *
 * Inspecting the code points found U+202F — NARROW NO-BREAK SPACE — between "31" and
 * "March". Models emit typographically-correct characters: narrow spaces in dates,
 * non-breaking hyphens in identifiers (A‑1001), curly quotes in prose. All of them
 * look identical to the ASCII versions and none of them compare equal.
 *
 * So a string-matching eval produces FALSE FAILURES unless you normalise first. And a
 * false failure is expensive in a different way from a false pass: it trains you to
 * ignore the suite.
 *
 * NFKC handles most space variants. It does NOT fully handle dashes (U+2011 becomes
 * U+2010, still not ASCII), so those are replaced explicitly.
 */
function normalise(text) {
  return (text ?? '')
    .normalize('NFKC')
    // every space-like character → a plain space
    .replace(/[     ⁠]/g, ' ')
    // every dash-like character → a plain hyphen
    .replace(/[‐-―−]/g, '-')
    // curly quotes → straight
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * `mustContain` / `mustNotContain`.
 *
 * Crude, and that's the point: it's deterministic, instant, free, and it cannot be
 * wrong about whether the string "4500" is present.
 *
 * ⚠️ `mustNotContain` is the half people skip, and it catches the most dangerous
 * failure — the near-miss. The leave paragraph contains 22, 28 AND 32. An answer of
 * "22 or 28 days depending on your grade" contains "28" and is still wrong.
 */
export function checkStrings(answer, { mustContain = [], mustNotContain = [] }) {
  const text = normalise(answer);
  const missing = mustContain.filter((s) => !text.includes(normalise(s)));
  const forbidden = mustNotContain.filter((s) => text.includes(normalise(s)));
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
    checked: mustContain.length + mustNotContain.length,
  };
}

export { normalise };

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ONE CASE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} testCase  from golden.js
 * @param {object} result    what answerQuestion() returned
 */
export function scoreCase(testCase, result) {
  const answered = Boolean(result.grounded);
  const retrievedPages = (result.retrieved ?? []).map((r) => r.page);

  const behaviour = classifyBehaviour(testCase.expect, answered);

  const retrieval = testCase.expectedPages
    ? {
        ...recallAtK(retrievedPages, testCase.expectedPages),
        mrr: reciprocalRank(retrievedPages, testCase.expectedPages),
        retrievedPages,
      }
    : null;

  const strings =
    testCase.mustContain || testCase.mustNotContain
      ? checkStrings(result.answer, testCase)
      : null;

  // The reason is INFORMATIVE, not pass/fail. Project 05's lesson: which lock catches
  // a case depends on the document, so pinning it would make the suite brittle —
  // it would "fail" when behaviour was still correct.
  const reasonNote =
    testCase.preferredReason && result.reason !== testCase.preferredReason
      ? `caught by "${result.reason}" rather than the usual "${testCase.preferredReason}"`
      : null;

  // ── The verdict ───────────────────────────────────────────────────────────
  // Behaviour first: answering when you should refuse is a failure however good the
  // prose is. Then retrieval, then string checks.
  const failures = [];
  if (behaviour === 'false_accept') failures.push('answered when it should have refused');
  if (behaviour === 'false_refusal') failures.push('refused when it should have answered');
  if (retrieval && !retrieval.hit) failures.push(`expected page(s) ${testCase.expectedPages} not retrieved`);
  if (strings && !strings.ok) {
    if (strings.missing.length) failures.push(`answer missing: ${strings.missing.join(', ')}`);
    if (strings.forbidden.length) failures.push(`answer contains forbidden: ${strings.forbidden.join(', ')}`);
  }

  const passed = failures.length === 0;

  return {
    id: testCase.id,
    doc: testCase.doc,
    tags: testCase.tags ?? [],
    passed,
    failures,
    behaviour,
    retrieval,
    strings,
    reasonNote,
    // Carried through for the report and for the judge.
    knownFailure: testCase.knownFailure ?? null,
    // A known failure that now PASSES is news worth shouting about.
    fixedKnownFailure: Boolean(testCase.knownFailure) && passed,
    actual: {
      answered,
      reason: result.reason ?? null,
      answer: result.answer,
      bestSimilarity: result.bestSimilarity ?? null,
      citedPages: (result.citations ?? []).map((c) => c.page),
      costUsd: result.costUsd ?? 0,
      latencyMs: result.latencyMs ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the rate and retrieval metrics over a set of scores.
 *
 * Factored out because we report them TWICE — see the note in aggregate().
 */
function computeRates(scores) {
  const counts = { correct_answer: 0, correct_refusal: 0, false_accept: 0, false_refusal: 0 };
  for (const s of scores) counts[s.behaviour]++;

  const withRetrieval = scores.filter((s) => s.retrieval);
  const avg = (fn) =>
    withRetrieval.length ? withRetrieval.reduce((n, s) => n + fn(s), 0) / withRetrieval.length : null;

  const shouldAnswer = counts.correct_answer + counts.false_refusal;
  const shouldRefuse = counts.correct_refusal + counts.false_accept;

  return {
    behaviour: counts,
    // ⭐ The two rates that matter, and that trade against each other.
    falseAcceptRate: shouldRefuse ? counts.false_accept / shouldRefuse : 0,
    falseRefusalRate: shouldAnswer ? counts.false_refusal / shouldAnswer : 0,
    retrieval: {
      recall: withRetrieval.length ? withRetrieval.filter((s) => s.retrieval.hit).length / withRetrieval.length : null,
      mrr: avg((s) => s.retrieval.mrr),
      coverage: avg((s) => s.retrieval.coverage),
      cases: withRetrieval.length,
    },
  };
}

/**
 * ⚠️ WHY THE RATES ARE REPORTED TWICE.
 *
 * The first version of this report said "+2 known failures, excluded" and then printed
 * a single set of rates — which silently INCLUDED those same two failures. Recall read
 * 80% and false-refusal 20%, both driven entirely by the known multi-hop cases, while
 * the header implied they'd been taken out.
 *
 * That's the worst kind of reporting bug: not wrong exactly, but inviting the reader to
 * draw a false conclusion. Both numbers are legitimate and they answer different
 * questions:
 *
 *   ALL      what the system actually does today, warts included.
 *            This is what the gate judges, because users experience the warts.
 *
 *   TRACKED  how it does on everything we haven't already accepted as broken.
 *            This is what tells you whether a CHANGE made things worse.
 *
 * Reporting one without the other either hides real failures or buries a new
 * regression inside a number you've already learned to ignore.
 */
export function aggregate(scores) {
  const tracked = scores.filter((s) => !s.knownFailure);
  const known = scores.filter((s) => s.knownFailure);

  const all = computeRates(scores);
  const trackedOnly = computeRates(tracked);

  return {
    total: scores.length,
    tracked: tracked.length,
    passed: tracked.filter((s) => s.passed).length,
    failed: tracked.filter((s) => !s.passed).length,
    knownFailures: known.length,
    knownFailuresNowPassing: known.filter((s) => s.passed).length,

    // Spread the ALL-case numbers at the top level: the gate judges reality.
    ...all,

    // And keep the known-failures-excluded view alongside, for spotting regressions.
    excludingKnown: trackedOnly,

    costUsd: scores.reduce((n, s) => n + s.actual.costUsd, 0),
    latencyMs: scores.reduce((n, s) => n + s.actual.latencyMs, 0),
  };
}
