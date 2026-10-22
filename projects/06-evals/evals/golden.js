/**
 * THE GOLDEN DATASET.
 *
 * A fixed set of questions with known-correct outcomes, run identically every time, so
 * today's behaviour can be compared with last month's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Everything in project 05 was verified by hand, on questions I chose, right after I
 * wrote the code. That has three problems:
 *
 *   1. I picked questions I expected to pass. (And when the user picked their own,
 *      they immediately found a case where hybrid search was WORSE than vector alone.)
 *   2. It doesn't scale — 20 questions by hand is an afternoon.
 *   3. It catches nothing later. Change the chunk size in three weeks and nothing
 *      tells you retrieval got worse.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES A GOOD CASE
 *
 * Every case must have an outcome you can check WITHOUT reading the answer yourself.
 * "Looks reasonable" is not a test. So each one carries:
 *
 *   expect          'answer' or 'refuse' — the behaviour, checkable with ===
 *   expectedPages   which page SHOULD be retrieved — scores retrieval on its own
 *   mustContain     strings the answer must include — cheap correctness
 *   mustNotContain  strings it must NOT — catches the near-miss answer
 *
 * `mustNotContain` is the one people forget. "How much leave on grade 7?" has three
 * plausible wrong answers sitting in the same paragraph (22, 32). An eval that only
 * checks for "28" passes an answer saying "22 or 28 depending on grade".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** @typedef {'answer'|'refuse'} Expectation */

export const CASES = [
  // ── Grounded: the document answers these, and we know the answer ────────────
  {
    id: 'leave-grade7',
    doc: 'handbook',
    question: 'How many days of annual leave does a grade 7 employee get?',
    expect: 'answer',
    expectedPages: [2],
    mustContain: ['28'],
    // The trap values from the same paragraph.
    mustNotContain: ['22 days', '32 days'],
    tags: ['grounded', 'numeric'],
  },
  {
    id: 'meal-international',
    doc: 'handbook',
    question: 'What is the meal allowance when travelling internationally?',
    expect: 'answer',
    expectedPages: [3],
    mustContain: ['4500'],
    // 1200 is the DOMESTIC allowance, two lines above. Near-miss.
    mustNotContain: ['1200'],
    tags: ['grounded', 'numeric', 'near-miss-in-same-chunk'],
  },
  {
    id: 'laptop-return',
    doc: 'handbook',
    question: 'How long do I have to return my laptop after leaving?',
    expect: 'answer',
    expectedPages: [4],
    mustContain: ['5'],
    tags: ['grounded', 'numeric'],
  },
  {
    id: 'overtime-holiday',
    doc: 'handbook',
    question: 'What rate is overtime paid at on a public holiday?',
    expect: 'answer',
    expectedPages: [1],
    mustContain: ['2'],
    tags: ['grounded', 'numeric'],
  },
  {
    id: 'carry-over-expiry',
    doc: 'handbook',
    question: 'When do carried-over annual leave days expire?',
    expect: 'answer',
    expectedPages: [2],
    mustContain: ['31 March'],
    tags: ['grounded', 'date'],
  },

  // ── Out of scope: nothing in the document is relevant ───────────────────────
  {
    id: 'oos-redis',
    doc: 'handbook',
    question: 'How do I configure Redis maxmemory policy?',
    expect: 'refuse',
    // Which LOCK should catch it. Optional, and deliberately soft: if this changes
    // it's informative rather than a failure — see scoreCase() in metrics.js.
    preferredReason: 'below_similarity_gate',
    tags: ['out-of-scope', 'foreign-topic'],
  },
  {
    id: 'oos-france',
    doc: 'handbook',
    question: 'What is the capital of France?',
    expect: 'refuse',
    preferredReason: 'below_similarity_gate',
    tags: ['out-of-scope', 'foreign-topic'],
  },

  // ── Traps: topically close, genuinely unanswerable ──────────────────────────
  {
    id: 'trap-grade12',
    doc: 'handbook',
    question: 'How many days of annual leave does a grade 12 employee get?',
    expect: 'refuse',
    // This one PASSES the similarity gate — it's textually near-identical to the
    // grade 5/7/9 lines. Lock 2 has to catch it. Documented in project 05.
    preferredReason: 'model_said_insufficient',
    tags: ['trap', 'near-duplicate', 'gate-cannot-catch'],
  },
  {
    id: 'trap-dental',
    doc: 'handbook',
    question: 'What is the dental insurance policy?',
    expect: 'refuse',
    tags: ['trap', 'plausible-topic'],
  },
  {
    id: 'trap-invented-structure',
    doc: 'handbook',
    question: 'What are the five categories of expense claim?',
    expect: 'refuse',
    // Presupposes a list that doesn't exist. A helpful model invents five.
    tags: ['trap', 'invented-structure'],
  },

  // ── The book: prose rather than fact tables ─────────────────────────────────
  {
    id: 'book-not-the-voice',
    doc: 'book',
    question: 'What does the author mean when he says you are not the voice in your head?',
    expect: 'answer',
    expectedPages: [35, 36],
    tags: ['grounded', 'prose'],
  },
  {
    id: 'book-monkey-mind',
    doc: 'book',
    question: 'What do Buddhism and Islam call the voice in your head?',
    expect: 'answer',
    expectedPages: [35],
    mustContain: ['monkey mind', 'whisper'],
    tags: ['grounded', 'prose'],
  },
  {
    id: 'book-wrong-son',
    doc: 'book',
    question: 'What does the author say about his son Omar?',
    expect: 'refuse',
    // His son is Ali. One wrong proper noun.
    tags: ['trap', 'wrong-proper-noun'],
  },
  // ── An altered quote, WITH its control ──────────────────────────────────────
  //
  // ⚠️ A trap without a control is not a test. If the system refuses everything,
  // the trap "passes" and tells you nothing. The pair is the test: refuse the
  // altered version, answer the true one.
  //
  // Measured 4/4 and 4/4 before being added here — see the note below about why
  // stability matters.
  {
    id: 'book-altered-song',
    doc: 'book',
    question: "What does the author say about Pink Floyd's song 'Comfortably Numb'?",
    expect: 'refuse',
    // The book discusses 'Brain Damage'. Real band, real song, wrong song.
    tags: ['trap', 'altered-detail'],
  },
  {
    id: 'book-control-song',
    doc: 'book',
    question: "What does the author say about Pink Floyd's song 'Brain Damage'?",
    expect: 'answer',
    expectedPages: [35, 34],
    tags: ['grounded', 'control-for-altered-detail'],
  },

  // ⚠️ REMOVED: `book-altered-quote` — "I always KNEW it was me" (the book says
  // "thought"). It was in the first version of this dataset because the system
  // refused it once during manual testing, and that single observation got written
  // down as ground truth.
  //
  // Re-running it 6 times gave 6 answers, not 6 refusals — and on inspection the
  // answers were defensible: "he believed or thought the voice was himself" is
  // exactly what the passage says. The model was silently correcting the misquote
  // rather than hallucinating, which is reasonable behaviour for a one-word
  // paraphrase.
  //
  // THE LESSON: a golden case whose expected outcome came from one observed run is
  // a SNAPSHOT, not a SPECIFICATION. If you can't say why an outcome is correct
  // without pointing at a previous run, the case is not ready. Replaced with the
  // song pair above, where "wrong song" is unambiguously a factual error.
  {
    id: 'book-oos-keto',
    doc: 'book',
    question: 'What does the author say about the ketogenic diet and brain fog?',
    expect: 'refuse',
    tags: ['out-of-scope', 'plausible-topic'],
  },

  // ── ⭐ KNOWN FAILURES — tracked, not hidden ─────────────────────────────────
  //
  // An eval suite that only contains passing cases is a suite that tells you nothing
  // you didn't already know.
  //
  // `knownFailure` means: we expect this to fail today, for a documented reason. The
  // suite still PASSES — but it reports the failure, and crucially it tells you when
  // the case starts passing, because a fixed known-failure should be celebrated and
  // then promoted to a normal case.
  {
    id: 'multihop-monkey-software',
    doc: 'book',
    question:
      'What does the author say about both the monkey mind and about reprogramming your brain like software?',
    expect: 'answer',
    expectedPages: [35],
    knownFailure:
      'Multi-hop. One question becomes one embedding; a two-topic question averages ' +
      'both topics and lands near neither. Page 35 (monkey mind) is never retrieved — ' +
      'the software half dominates. Fix: query decomposition. See project 05 NOTES §8.',
    tags: ['known-failure', 'multihop'],
  },
  {
    id: 'multihop-son-suffering',
    doc: 'book',
    question:
      'What does the author say about his son and about how suffering changed his view of the mind?',
    expect: 'answer',
    expectedPages: [312, 237],
    knownFailure:
      'Multi-hop, worse variant: the combined query retrieves pages NEITHER sub-query ' +
      'finds, landing in generic "suffering and meaning" prose between the two topics.',
    tags: ['known-failure', 'multihop'],
  },
];

/**
 * Sanity-check the dataset itself.
 *
 * A broken eval suite is worse than none — it reports green while testing nothing.
 * So the suite validates its own shape before it runs.
 */
export function validateCases(cases = CASES) {
  const problems = [];
  const seen = new Set();

  for (const c of cases) {
    if (!c.id) problems.push('a case has no id');
    if (seen.has(c.id)) problems.push(`duplicate id: ${c.id}`);
    seen.add(c.id);

    if (!c.question) problems.push(`${c.id}: no question`);
    if (!['answer', 'refuse'].includes(c.expect)) {
      problems.push(`${c.id}: expect must be 'answer' or 'refuse'`);
    }
    // A case expecting an answer with nothing to check against is untestable —
    // it would pass on any answer at all, including a fabricated one.
    if (c.expect === 'answer' && !c.expectedPages?.length && !c.mustContain?.length) {
      problems.push(`${c.id}: expects an answer but has no expectedPages or mustContain`);
    }
    if (c.expect === 'refuse' && (c.mustContain || c.expectedPages)) {
      problems.push(`${c.id}: expects a refusal, so mustContain/expectedPages make no sense`);
    }
  }

  return { ok: problems.length === 0, problems, count: cases.length };
}

export const byTag = (tag, cases = CASES) => cases.filter((c) => c.tags?.includes(tag));
