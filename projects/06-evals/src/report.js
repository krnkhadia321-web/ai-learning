/**
 * Report rendering.
 *
 * A number with no explanation gets ignored. The report's job is to make a failure
 * ACTIONABLE — which case, what was expected, what happened, and crucially whether it
 * was retrieval or answering that broke, because those have different fixes.
 */

const pct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(0)}%`);
const num = (n, d = 3) => (n === null || n === undefined ? '—' : n.toFixed(d));

export function renderReport(scores, summary) {
  const L = [];
  const line = (s = '') => L.push(s);

  line('');
  line('═'.repeat(78));
  line('  EVAL REPORT');
  line('═'.repeat(78));

  // ── Headline ───────────────────────────────────────────────────────────────
  line('');
  line(`  ${summary.passed}/${summary.tracked} tracked cases passed` +
       (summary.knownFailures ? `   (+${summary.knownFailures} known failures, excluded)` : ''));
  line(`  cost $${(summary.costUsd + summary.judgeCostUsd).toFixed(6)}` +
       `   (system $${summary.costUsd.toFixed(6)} + judge $${summary.judgeCostUsd.toFixed(6)})` +
       `   ${(summary.latencyMs / 1000).toFixed(1)}s`);

  // ── Behaviour: the confusion matrix ────────────────────────────────────────
  const b = summary.behaviour;
  line('');
  line('  BEHAVIOUR — did it answer when it should, and refuse when it should?');
  line('');
  line('                      should ANSWER      should REFUSE');
  line(`     answered         ✅ ${String(b.correct_answer).padEnd(14)} ❌ ${b.false_accept}  ← false accept`);
  line(`     refused          ❌ ${String(b.false_refusal).padEnd(14)} ✅ ${b.correct_refusal}`);
  const ex = summary.excludingKnown;
  const hasKnown = summary.knownFailures > 0;

  line('');
  line(`                              ALL cases${hasKnown ? '    excl. known failures' : ''}`);
  line(
    `     false ACCEPT rate       ${pct(summary.falseAcceptRate).padStart(5)}` +
      (hasKnown ? `            ${pct(ex.falseAcceptRate).padStart(5)}` : '') +
      `   ← a wrong answer reaching a user`,
  );
  line(
    `     false REFUSAL rate      ${pct(summary.falseRefusalRate).padStart(5)}` +
      (hasKnown ? `            ${pct(ex.falseRefusalRate).padStart(5)}` : '') +
      `   ← annoying, but safe`,
  );

  // ── Retrieval, scored on its own ───────────────────────────────────────────
  line('');
  line(`  RETRIEVAL — scored separately, across ${summary.retrieval.cases} cases that claim a page`);
  line('');
  line(`                              ALL cases${hasKnown ? '    excl. known failures' : ''}`);
  line(
    `     recall@k                ${pct(summary.retrieval.recall).padStart(5)}` +
      (hasKnown ? `            ${pct(ex.retrieval.recall).padStart(5)}` : '') +
      `   was an expected page retrieved?`,
  );
  line(
    `     MRR                     ${num(summary.retrieval.mrr).padStart(5)}` +
      (hasKnown ? `            ${num(ex.retrieval.mrr).padStart(5)}` : '') +
      `   how high? (1.0 = rank 1)`,
  );
  line(
    `     coverage                ${pct(summary.retrieval.coverage).padStart(5)}` +
      (hasKnown ? `            ${pct(ex.retrieval.coverage).padStart(5)}` : '') +
      `   fraction of expected pages found`,
  );

  if (hasKnown) {
    line('');
    line(`     The gate judges the ALL column — users experience the known failures too.`);
    line(`     The right-hand column is what tells you whether a CHANGE made things worse.`);
  }

  // ── Failures, with enough detail to act on ─────────────────────────────────
  const failed = scores.filter((s) => !s.passed && !s.knownFailure);
  if (failed.length) {
    line('');
    line('─'.repeat(78));
    line('  ❌ FAILURES');
    line('─'.repeat(78));
    for (const s of failed) {
      line('');
      line(`  ${s.id}   [${s.tags.join(', ')}]`);
      for (const f of s.failures) line(`     · ${f}`);
      // The diagnosis that matters: which half broke?
      if (s.retrieval && !s.retrieval.hit) {
        line(`     → RETRIEVAL problem: expected ${JSON.stringify(s.retrieval.missed)}, got ${JSON.stringify(s.retrieval.retrievedPages)}`);
        line(`       fixes live in chunking, query handling, or reranking`);
      } else if (s.behaviour === 'false_accept' || s.behaviour === 'false_refusal' || s.groundedness?.score < 1) {
        line(`     → ANSWERING problem: retrieval was fine, the generation step failed`);
        line(`       fixes live in the prompt, the model, or the output contract`);
      }
      line(`     answer: ${JSON.stringify((s.actual.answer ?? '').slice(0, 110))}`);
      if (s.groundedness?.claims?.length) {
        for (const c of s.groundedness.claims.filter((x) => !x.supported)) {
          line(`     judge: UNSUPPORTED — ${JSON.stringify(c.claim.slice(0, 90))}`);
        }
      }
    }
  }

  // ── Known failures ─────────────────────────────────────────────────────────
  const known = scores.filter((s) => s.knownFailure);
  if (known.length) {
    line('');
    line('─'.repeat(78));
    line('  ⚠️  KNOWN FAILURES — tracked, excluded from the pass rate');
    line('─'.repeat(78));
    for (const s of known) {
      line('');
      if (s.passed) {
        // Loud on purpose: a known failure that starts passing means someone fixed
        // something, and the case should be promoted to a normal one.
        line(`  🎉 ${s.id} — NOW PASSING. Remove its knownFailure and promote it.`);
      } else {
        line(`  ⚠️  ${s.id}   [${s.tags.join(', ')}]`);
        line(`     ${s.knownFailure.replace(/\s+/g, ' ')}`);
        if (s.retrieval) {
          line(`     expected pages ${JSON.stringify(s.retrieval.missed)}, retrieved ${JSON.stringify(s.retrieval.retrievedPages)}`);
        }
      }
    }
  }

  // ── Notes worth seeing but not failing on ──────────────────────────────────
  const notes = scores.filter((s) => s.reasonNote);
  if (notes.length) {
    line('');
    line('  NOTES (informative, not failures)');
    for (const s of notes) line(`     · ${s.id}: ${s.reasonNote}`);
  }

  // ── The gate ───────────────────────────────────────────────────────────────
  line('');
  line('─'.repeat(78));
  line(`  GATE — ${summary.gate.passed ? '✅ PASS' : '❌ FAIL'}`);
  line('─'.repeat(78));
  line('');
  for (const c of summary.gate.checks) {
    const cmp = c.higherIsBetter ? '≥' : '≤';
    const shown = c.name.includes('rate') ? pct(c.actual) : num(c.actual);
    const limit = c.name.includes('rate') ? pct(c.limit) : num(c.limit);
    const mark = c.notMeasured ? '➖' : c.ok ? '✅' : '❌';
    line(`     ${mark} ${c.name.padEnd(20)} ${String(shown).padStart(6)}  ${cmp} ${limit}`);
    if (c.notMeasured) line(`        not measured by this run — no case declares an expected page`);
    else if (!c.ok) line(`        ${c.why}`);
  }
  line('');
  line('═'.repeat(78));
  line('');

  return L.join('\n');
}

/** Compact one-line summary, for CI logs and for comparing runs. */
export function renderOneLine(summary) {
  return (
    `pass ${summary.passed}/${summary.tracked} · ` +
    `falseAccept ${pct(summary.falseAcceptRate)} · ` +
    `falseRefusal ${pct(summary.falseRefusalRate)} · ` +
    `recall ${pct(summary.retrieval.recall)} · ` +
    `mrr ${num(summary.retrieval.mrr, 2)} · ` +
    `gate ${summary.gate.passed ? 'PASS' : 'FAIL'}`
  );
}
