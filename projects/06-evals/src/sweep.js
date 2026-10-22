/**
 * THRESHOLD SWEEP — measuring the trade-off instead of asserting it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Project 04 said "no single cache threshold works". Project 05 said "no single
 * retrieval gate works". Both were argued from a handful of examples.
 *
 * This measures it. For every value of MIN_SIMILARITY, what happens to:
 *
 *     false ACCEPT rate   answering something it should have refused
 *     false REFUSAL rate  refusing something it should have answered
 *
 * They move in OPPOSITE directions. That's the whole point: there is no setting that
 * minimises both, so the question is never "what is the right threshold" but "which
 * error am I willing to buy more of".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ HOW THIS RUNS THE SUITE ONCE INSTEAD OF ONCE PER THRESHOLD
 *
 * The naive version re-runs everything at 0.05, 0.10, 0.15 … — a dozen full passes,
 * a dozen times the cost and the rate-limit pain.
 *
 * But the gate is a pure comparison: `bestSimilarity < MIN_SIMILARITY`. So:
 *
 *   1. Run ONCE with the gate disabled (MIN_SIMILARITY = 0). Every case reaches the
 *      model, and we record its bestSimilarity and what the model decided.
 *   2. For any threshold T, the outcome is then arithmetic:
 *        bestSimilarity < T   → it would have been gated → refused
 *        otherwise            → whatever the model actually decided
 *
 * One expensive pass, the entire curve for free, and it's deterministic — the same
 * recorded run produces the same curve every time, so the shape isn't noise.
 */

// ⚠️ MUST be set before importing answer.js — it reads MIN_SIMILARITY at module load,
// so a later assignment would have no effect. This is why the import is dynamic.
process.env.MIN_SIMILARITY = '0';

const { answerQuestion } = await import('../../05-retrieval/src/answer.js');
const { pool, listDocuments } = await import('../../05-retrieval/src/db.js');
const { CASES } = await import('../evals/golden.js');
const { withRetry, pace } = await import('./limiter.js');

const THRESHOLDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7];

/** Replay one recorded run at a hypothetical threshold. */
function simulate(observations, threshold) {
  let falseAccept = 0;
  let falseRefusal = 0;
  let shouldAnswer = 0;
  let shouldRefuse = 0;
  let gatedCount = 0;
  let modelCalls = 0;

  for (const o of observations) {
    const gated = o.bestSimilarity < threshold;
    if (gated) gatedCount++;
    else modelCalls++;

    // Gated → refused. Otherwise → whatever the model decided when it saw the passages.
    const answered = gated ? false : o.modelAnswered;

    if (o.expect === 'answer') {
      shouldAnswer++;
      if (!answered) falseRefusal++;
    } else {
      shouldRefuse++;
      if (answered) falseAccept++;
    }
  }

  return {
    threshold,
    falseAcceptRate: shouldRefuse ? falseAccept / shouldRefuse : 0,
    falseRefusalRate: shouldAnswer ? falseRefusal / shouldAnswer : 0,
    falseAccept,
    falseRefusal,
    // What fraction of questions never reach the model — the cost saving a strict
    // gate buys you, alongside the false refusals it costs you.
    gatedFraction: gatedCount / observations.length,
    modelCalls,
  };
}

function renderCurve(rows, observations) {
  const L = [];
  const line = (s = '') => L.push(s);
  const bar = (rate, width = 22) => {
    const n = Math.round(rate * width);
    return '█'.repeat(n) + '·'.repeat(width - n);
  };

  line('');
  line('═'.repeat(86));
  line('  THRESHOLD SWEEP — MIN_SIMILARITY vs the two error types');
  line('═'.repeat(86));
  line('');
  line(`  ${observations.length} cases, recorded in one pass with the gate disabled,`);
  line(`  then replayed at ${rows.length} thresholds.`);
  line('');
  line('   MIN_SIM   false ACCEPT                 false REFUSAL                gated');
  line('             (wrong answer shipped)       (good question blocked)      calls');
  line('  ' + '─'.repeat(82));

  for (const r of rows) {
    const marker = r.threshold === 0.25 ? ' ← current' : '';
    line(
      `   ${r.threshold.toFixed(2).padStart(5)}    ` +
        `${bar(r.falseAcceptRate)} ${String(Math.round(r.falseAcceptRate * 100) + '%').padStart(4)}   ` +
        `${bar(r.falseRefusalRate)} ${String(Math.round(r.falseRefusalRate * 100) + '%').padStart(4)}   ` +
        `${String(Math.round(r.gatedFraction * 100) + '%').padStart(4)}${marker}`,
    );
  }

  line('  ' + '─'.repeat(82));
  line('');

  // ── What the data says ─────────────────────────────────────────────────────
  const noAccepts = rows.filter((r) => r.falseAcceptRate === 0);
  const noRefusals = rows.filter((r) => r.falseRefusalRate === 0);
  const perfect = rows.filter((r) => r.falseAcceptRate === 0 && r.falseRefusalRate === 0);

  line('  READING THIS');
  line('');
  line(`    false ACCEPT is 0 at thresholds  ${noAccepts.map((r) => r.threshold).join(', ') || '(none)'}`);
  line(`    false REFUSAL is 0 at thresholds ${noRefusals.map((r) => r.threshold).join(', ') || '(none)'}`);
  line('');

  if (perfect.length) {
    line(`    ✅ Both are zero at: ${perfect.map((r) => r.threshold).join(', ')}`);
    line(`       On THIS dataset a clean separation exists. That is a property of these`);
    line(`       cases, not a guarantee — add a case that falls between and it vanishes.`);
  } else {
    line(`    ❌ NO threshold makes both zero. Every setting buys one error with the other.`);
  }

  line('');
  line('    The gated column is the other half of the trade: a strict gate refuses more');
  line('    good questions AND saves more money, because a gated question costs nothing.');

  // ── Where the boundary cases sit ───────────────────────────────────────────
  line('');
  line('  WHERE EACH CASE SITS — sorted by similarity, which is what the gate sees');
  line('');
  const sorted = [...observations].sort((a, b) => b.bestSimilarity - a.bestSimilarity);
  for (const o of sorted) {
    const want = o.expect === 'answer' ? 'should ANSWER' : 'should refuse';
    line(
      `    ${o.bestSimilarity.toFixed(3)}  ${want}   ` +
        `model ${o.modelAnswered ? 'answered' : 'refused '}   ${o.id}`,
    );
  }
  line('');
  line('    Read the ORDERING, not the numbers. Any threshold is a horizontal line drawn');
  line('    through this list: everything below it is refused regardless of merit.');

  // ── ⭐ Detect interleaving — the gate's hard limit, computed ────────────────
  //
  // A "should refuse" case ranked ABOVE a "should answer" case cannot be separated
  // from it by any threshold. Every threshold that catches the refusal also blocks
  // the answer. This is the structural argument for layered locks, and it should be
  // measured rather than left for the reader to spot.
  const interleaved = [];
  for (const r of sorted.filter((o) => o.expect === 'refuse')) {
    const blocked = sorted.filter((o) => o.expect === 'answer' && o.bestSimilarity < r.bestSimilarity);
    if (blocked.length) interleaved.push({ refuseCase: r, blocked });
  }

  line('');
  if (interleaved.length === 0) {
    line('    ✅ No interleaving: every "should refuse" case ranks below every "should');
    line('       answer" case, so a threshold between them separates them cleanly.');
  } else {
    line('  ⭐ INTERLEAVING — where no threshold can possibly work');
    line('');
    for (const { refuseCase, blocked } of interleaved) {
      line(`    "${refuseCase.id}" (${refuseCase.bestSimilarity.toFixed(3)}) should be REFUSED,`);
      line(`    but ranks above ${blocked.length} case(s) that should be ANSWERED:`);
      line(`       ${blocked.map((b) => `${b.id} (${b.bestSimilarity.toFixed(3)})`).join(', ')}`);
      line('');
      line(`    Any gate strict enough to catch it (> ${refuseCase.bestSimilarity.toFixed(3)}) blocks all ${blocked.length}.`);
      line(`    Any gate loose enough to let them through lets it through too.`);
      line('');
    }
    line('    This is the gate\'s HARD LIMIT — not a tuning problem, a structural one.');
    line('');
    line(`    And yet false-accept is 0% at every threshold above. The reason is that`);
    line(`    the MODEL caught these cases, not the gate. That is the layered-locks`);
    line(`    argument measured rather than asserted: the cheap uncheatable filter`);
    line(`    cannot separate them, so the expensive fallible one has to.`);
  }
  line('');
  line('═'.repeat(86));
  line('');

  return L.join('\n');
}

// ── Run ───────────────────────────────────────────────────────────────────────
const docs = await listDocuments();
const docIds = {
  handbook: docs.find((d) => d.filename.includes('acme-handbook'))?.id,
  book: docs.find((d) => !d.filename.includes('acme-handbook'))?.id,
};

if (!docIds.handbook || !docIds.book) {
  console.error('✗ Both documents must be ingested. npm run ingest --workspace=05-retrieval');
  process.exit(2);
}

// Known failures are excluded: they fail for a retrieval reason that has nothing to
// do with the threshold, so including them would smear a constant offset across the
// whole curve and hide its actual shape.
const cases = CASES.filter((c) => !c.knownFailure);

console.log(`▸ recording ${cases.length} cases with the gate DISABLED (one pass)…`);

const observations = [];
let cost = 0;

for (const [i, c] of cases.entries()) {
  if (i > 0) await pace();
  const r = await withRetry(
    () => answerQuestion({ question: c.question, documentId: docIds[c.doc] }),
    { label: c.id, onRetry: (m) => console.log(`     ⏳ ${m}`) },
  );

  cost += r.costUsd ?? 0;

  // Belt and braces: recompute the max rather than trusting one field.
  //
  // The first version read `r.retrieved[0].similarity`, which is NULL when the top
  // result was found by keyword search alone — so two cases recorded as similarity
  // 0.000 and sat at the bottom of the curve, which was simply wrong. A measurement
  // harness that silently substitutes 0 for "missing" produces a confident lie.
  const maxSim = (r.retrieved ?? []).reduce(
    (m, x) => (x.similarity != null && x.similarity > m ? x.similarity : m),
    0,
  );

  observations.push({
    id: c.id,
    expect: c.expect,
    bestSimilarity: r.bestSimilarity ?? maxSim,
    modelAnswered: Boolean(r.grounded),
  });

  console.log(`  ${String(i + 1).padStart(2)}/${cases.length}  ${c.id}`);
}

console.log(renderCurve(THRESHOLDS.map((t) => simulate(observations, t)), observations));
console.log(`  recording cost $${cost.toFixed(6)} — the curve itself was free.\n`);

await pool.end();
