import { pathToFileURL } from 'node:url';

import { CASES, validateCases } from '../evals/golden.js';
import { scoreCase, aggregate } from './metrics.js';
import { judgeGroundedness, judgeRefusal, judgeConfig } from './judge.js';
import { renderReport } from './report.js';
import { withRetry, pace, limiterConfig } from './limiter.js';

// The system under test. Imported DIRECTLY, not called over HTTP — so no server
// needs running, it's faster, and we can see the retrieved chunks, which is the
// whole point of scoring retrieval separately.
import { answerQuestion } from '../../05-retrieval/src/answer.js';
import { pool, listDocuments } from '../../05-retrieval/src/db.js';

/**
 * THE EVAL RUNNER.
 *
 *   for each case:
 *     ask the real system
 *     score deterministically        ← free, instant, cannot be wrong
 *     optionally ask the judge       ← slow, costs money, can be wrong
 *   aggregate
 *   report
 *   exit 0 or 1                      ← this is what makes it a CI gate
 */

// ── The gate thresholds ──────────────────────────────────────────────────────
//
// These are the numbers CI enforces. Setting them is a judgement call, and the right
// way to pick them is to run the suite, look at where you are, and set the bar
// slightly below — so it catches regressions without failing on day one.
const GATE = {
  // A false accept is a confident wrong answer reaching a user. Zero tolerance.
  maxFalseAcceptRate: Number(process.env.GATE_MAX_FALSE_ACCEPT ?? 0),
  // False refusals are annoying but safe, so there's some tolerance.
  maxFalseRefusalRate: Number(process.env.GATE_MAX_FALSE_REFUSAL ?? 0.2),
  // The generator cannot use what it never received, so recall is the ceiling
  // on everything downstream.
  minRecall: Number(process.env.GATE_MIN_RECALL ?? 0.8),
  minMrr: Number(process.env.GATE_MIN_MRR ?? 0.6),
};

export async function runEvals({ useJudge = true, filterTag = null, onProgress } = {}) {
  const log = onProgress ?? ((m) => console.log(m));

  // Validate the suite before trusting it. A broken eval reports green while
  // testing nothing, which is worse than having no eval at all.
  const validation = validateCases();
  if (!validation.ok) {
    throw new Error(`Golden dataset is invalid:\n  - ${validation.problems.join('\n  - ')}`);
  }

  // Resolve document names to ids once.
  const docs = await listDocuments();
  const docIds = {
    handbook: docs.find((d) => d.filename.includes('acme-handbook'))?.id,
    book: docs.find((d) => !d.filename.includes('acme-handbook'))?.id,
  };

  const missing = [...new Set(CASES.map((c) => c.doc))].filter((d) => !docIds[d]);
  if (missing.length) {
    throw new Error(
      `No ingested document for: ${missing.join(', ')}.\n` +
        `  Ingest first:  npm run ingest --workspace=05-retrieval`,
    );
  }

  const cases = filterTag ? CASES.filter((c) => c.tags?.includes(filterTag)) : CASES;
  log(
    `▸ ${cases.length} cases, judge ${useJudge ? `on (${judgeConfig.JUDGE_MODEL})` : 'off'}, ` +
      `pacing ${limiterConfig.PACE_MS}ms between cases`,
  );

  const scores = [];
  let judgeCost = 0;

  for (const [i, testCase] of cases.entries()) {
    // Pace between cases, and retry on 429. An eval suite is bursty by nature and
    // will hit rate limits normal usage never approaches — see limiter.js.
    if (i > 0) await pace();

    const result = await withRetry(
      () => answerQuestion({ question: testCase.question, documentId: docIds[testCase.doc] }),
      { label: testCase.id, onRetry: (m) => log(`     ⏳ ${m}`) },
    );

    const score = scoreCase(testCase, result);

    // ── The judge, only where it adds something ────────────────────────────
    //
    // Deliberately not run on every case. It's slow and costs money, and on a case
    // the string checks already settled it adds nothing. Two places it earns its keep:
    if (useJudge) {
      if (score.actual.answered) {
        // Is every claim actually supported by what it cited? String matching
        // can confirm "4500" is present; only a judge can tell you the sentence
        // around it is faithful.
        const g = await withRetry(
          () =>
            judgeGroundedness({
              question: testCase.question,
              answer: result.answer,
              citations: result.citations,
            }),
          { label: `${testCase.id} (judge)`, onRetry: (m) => log(`     ⏳ ${m}`) },
        );
        score.groundedness = g;
        judgeCost += g.costUsd ?? 0;

        // An unsupported claim is a failure even if every string check passed.
        if (g.score !== null && g.score < 1) {
          score.failures.push(`judge: ${g.unsupportedCount} unsupported claim(s)`);
          score.passed = false;
        }
      } else if (testCase.expect === 'answer') {
        // It refused a case we expected it to answer. Was that defensible given
        // what it actually retrieved? This distinguishes "the gate is too strict"
        // from "retrieval genuinely found nothing usable" — different fixes.
        const r = await withRetry(
          () =>
            judgeRefusal({
              question: testCase.question,
              retrieved: result.retrieved,
              refusalMessage: result.answer,
            }),
          { label: `${testCase.id} (judge)`, onRetry: (m) => log(`     ⏳ ${m}`) },
        );
        score.refusalJudgement = r;
        judgeCost += r.costUsd ?? 0;
      }
    }

    scores.push(score);
    log(
      `  ${score.passed ? '✅' : score.knownFailure ? '⚠️ ' : '❌'} ` +
        `${String(i + 1).padStart(2)}/${cases.length}  ${testCase.id}`,
    );
  }

  const summary = aggregate(scores);
  summary.judgeCostUsd = judgeCost;
  summary.gate = evaluateGate(summary);

  return { scores, summary, gate: GATE };
}

/**
 * Does this run pass the bar?
 *
 * Each check is reported separately. "The eval failed" is useless; "false accept rate
 * is 0.33, limit is 0" tells you what broke and by how much.
 */
export function evaluateGate(summary) {
  const checks = [
    {
      name: 'false accept rate',
      actual: summary.falseAcceptRate,
      limit: GATE.maxFalseAcceptRate,
      ok: summary.falseAcceptRate <= GATE.maxFalseAcceptRate,
      why: 'answering when it should refuse risks a confident wrong answer reaching a user',
    },
    {
      name: 'false refusal rate',
      actual: summary.falseRefusalRate,
      limit: GATE.maxFalseRefusalRate,
      ok: summary.falseRefusalRate <= GATE.maxFalseRefusalRate,
      why: 'refusing answerable questions makes the product useless, but is safe',
    },
    // ⚠️ A null metric PASSES, and that is a sharp edge worth understanding.
    //
    // `--tag=out-of-scope` selects only refusal cases, none of which declare an
    // expected page — so recall is null and these checks pass vacuously. That is the
    // right behaviour (you cannot fail a metric you did not measure) but it means a
    // tag filter can quietly remove a guarantee. The report prints "—" rather than a
    // number precisely so the absence is visible, and `notMeasured` flags it.
    {
      name: 'retrieval recall',
      actual: summary.retrieval.recall,
      limit: GATE.minRecall,
      ok: summary.retrieval.recall === null || summary.retrieval.recall >= GATE.minRecall,
      notMeasured: summary.retrieval.recall === null,
      why: 'the generator cannot use a passage it never received',
      higherIsBetter: true,
    },
    {
      name: 'retrieval MRR',
      actual: summary.retrieval.mrr,
      limit: GATE.minMrr,
      ok: summary.retrieval.mrr === null || summary.retrieval.mrr >= GATE.minMrr,
      notMeasured: summary.retrieval.mrr === null,
      why: 'the right passage ranked 4th is worse than ranked 1st, even if recall counts both',
      higherIsBetter: true,
    },
  ];

  return { passed: checks.every((c) => c.ok), checks };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const useJudge = !args.includes('--no-judge');
  const gateMode = args.includes('--gate');
  const tagArg = args.find((a) => a.startsWith('--tag='));

  // ⚠️ Set process.exitCode; do NOT call process.exit().
  //
  // process.exit() terminates immediately, so the `finally` that closes the Postgres
  // pool never finishes — and Node then crashes on Windows with:
  //
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
  //
  // which looks like a bug in the eval and is actually a bug in how it exits.
  // Setting exitCode lets the pool close and the process end naturally, carrying
  // the code with it.
  let exitCode = 0;

  try {
    const { scores, summary } = await runEvals({
      useJudge,
      filterTag: tagArg?.split('=')[1] ?? null,
    });

    console.log(renderReport(scores, summary));

    // The exit code IS the CI gate. Everything above is reporting; this is what
    // turns a report into something that can block a merge.
    if (gateMode && !summary.gate.passed) exitCode = 1;
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }

  process.exitCode = exitCode;
}
