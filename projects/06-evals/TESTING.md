# Project 06 — Testing guide

Every feature built in this project, with what to run and what you should see.

## ⚠️ Windows: use Git Bash, not PowerShell

**Run every command in this file in Git Bash.** In VS Code: the `+` dropdown at the top
right of the terminal panel → **Git Bash**.

In PowerShell, `curl` is an alias for `Invoke-WebRequest`, and `VAR=x cmd` isn't valid
syntax — several commands below set environment variables inline.

| Git Bash | PowerShell |
|---|---|
| `VAR=x node ...` | `$env:VAR='x'; node ...` |
| `A && B` | `A; if ($?) { B }` |

---

# Setup

Project 06 tests project 05, so **project 05's database must be up and populated.** No
server is needed — the evals import the functions directly.

```bash
# 1. Start Docker Desktop, then:
npm run db:up --workspace=05-retrieval

# 2. Make sure both documents are ingested:
docker exec ai-learning-postgres psql -U rag -d rag -c "SELECT filename, chunk_count FROM documents;"
```

Expect the handbook (8 chunks) and your book (1,380 chunks). If the table doesn't exist
or is empty:

```bash
cd projects/05-retrieval
node scripts/make-sample-pdf.js
node --env-file=../../.env src/ingest.js            # ingests everything in docs/
```

> ⚠️ **`npm run db:reset` wipes the volume.** If you ran it during project 05's testing,
> re-ingest before the evals, or every case fails for lack of data.

---
---

# PART A — The main runs

## A1. The full suite

```bash
npm run eval --workspace=06-evals -- --no-judge
```

`--no-judge` first: faster, free, and the deterministic checks are the ones that catch
regressions reliably.

**Expect** 18 cases, ~30 seconds, and a report ending:

```
  16/16 tracked cases passed   (+2 known failures, excluded)

                              ALL cases    excl. known failures
     false ACCEPT rate          0%               0%
     false REFUSAL rate        20%               0%
     recall@k                  80%             100%
     MRR                     0.800            1.000

  GATE — ✅ PASS
```

**Read the two columns.** Everything not already accepted as broken is perfect; the
20%/80% is entirely the two documented multi-hop failures.

---

## A2. ⭐⭐ The threshold sweep — the best output in the project

```bash
npm run eval:sweep --workspace=06-evals
```

This runs the suite **once** with the gate disabled, then replays twelve thresholds as
arithmetic. One expensive pass, the whole curve free.

**Expect** the curve, then — the part that matters — the sorted list:

```
    0.851  should ANSWER   leave-grade7
    0.806  should refuse   trap-grade12          ← second from the top
    0.683  should ANSWER   carry-over-expiry
    ...six more should-ANSWER cases...
    0.513  should ANSWER   book-monkey-mind
    0.465  should refuse   book-wrong-son
```

and the computed conclusion:

```
  ⭐ INTERLEAVING — where no threshold can possibly work

    "trap-grade12" (0.806) should be REFUSED,
    but ranks above 7 case(s) that should be ANSWERED

    Any gate strict enough to catch it (> 0.806) blocks all 7.
    Any gate loose enough to let them through lets it through too.
```

**Proves** what projects 04 and 05 only asserted: **no threshold exists.** Not a tuning
problem — a structural one.

Then note the curve shows **0% false accepts at every threshold**. The gate never caught
`trap-grade12`; the model did. That's the layered-locks argument, measured.

---

## A3. The judge

```bash
EVAL_PACE_MS=4000 node --env-file=../../.env src/run.js --tag=grounded
```

(from `projects/06-evals`. Higher pacing because the judge doubles the call volume.)

**Expect** 8 cases, all passing, and in the cost line:

```
  cost $0.003856   (system $0.001940 + judge $0.001916)
```

**Look at that split.** The judge costs about the same as the system under test —
**running evals with a judge roughly doubles the price.** That's why CI runs
`--no-judge` and the judge is better on a schedule.

To see the judge actually reject something, make a case fail: edit `golden.js` and add
`mustContain: ['42']` to a grounded case. The string check fails first, but the report
will show the judge's per-claim breakdown alongside.

---

## A4. Prove the gate blocks a regression ⭐

The whole point of a gate is that it stops a bad change. So break something.

**Open `projects/05-retrieval/src/answer.js`** and sabotage the top-k:

```js
const TOP_K = Number(process.env.ANSWER_TOP_K ?? 5);
                                                 ↑ change to 1
```

Then:

```bash
npm run eval --workspace=06-evals -- --no-judge
```

**Expect** recall to drop as questions whose answer sat at rank 2+ now miss, and the
gate to fail with a non-zero exit code.

Even better — don't edit the file, just set the env var:

```bash
cd projects/06-evals
ANSWER_TOP_K=1 node --env-file=../../.env src/run.js --gate --no-judge
echo "exit code: $?"
```

**Expect a non-zero exit code.** That number is what CI reads; everything else is
decoration.

**Restore `ANSWER_TOP_K` afterwards** (or just don't set it).

---

## A5. Exit codes — what CI actually reads

```bash
cd projects/06-evals

# passing run
node --env-file=../../.env src/run.js --gate --no-judge --tag=out-of-scope > /dev/null 2>&1
echo "pass → $?"          # expect 0

# impossible threshold forces a failure
GATE_MAX_FALSE_REFUSAL=-1 node --env-file=../../.env src/run.js --gate --no-judge --tag=grounded > /dev/null 2>&1
echo "fail → $?"          # expect 1
```

**Expect `0` then `1`**, and **no crash**.

> If you ever see `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, that's
> `process.exit()` racing the database pool close. The fix — setting `process.exitCode`
> instead — is in `run.js`, and the comment explains why.

---

## A6. Filters, and a sharp edge worth seeing

```bash
cd projects/06-evals
node --env-file=../../.env src/run.js --no-judge --tag=out-of-scope
```

**Expect** only refusal cases, and in the gate block:

```
     ➖ retrieval recall          —  ≥ 0.800
        not measured by this run — no case declares an expected page
```

**That `➖` matters.** No refusal case declares an expected page, so recall is
unmeasurable — and a metric you didn't measure passes vacuously. That's correct
behaviour, but it means **a tag filter can quietly remove a guarantee**, which is why
it's flagged rather than shown as a green tick.

Other useful tags: `grounded`, `trap`, `known-failure`, `multihop`, `numeric`.

---

## A7. Watch the rate limiter work

```bash
cd projects/06-evals
EVAL_PACE_MS=0 node --env-file=../../.env src/run.js --no-judge
```

With pacing off, you should see retries:

```
     ⏳ rate limited on book-oos-keto, waiting 6168ms (attempt 1/5)
```

**Proves** the thing that killed the very first run: eval suites are **bursty**. A human
sends one request every few seconds; this sends 18 back to back. The free tier's limit
is **8,000 tokens per minute**, and each case ships five retrieved passages.

Note the wait times are the provider's own (`try again in 6.168s`), parsed from the
error — honouring its number beats guessing, since it knows when the window resets.

---

## Checklist

| # | Run | Pass if |
|---|---|---|
| A1 | `npm run eval -- --no-judge` | 16/16 tracked, gate ✅, two columns shown |
| A2 | `npm run eval:sweep` | interleaving section names `trap-grade12` above 7 cases |
| A3 | `--tag=grounded` with judge | 8/8, judge cost ≈ system cost |
| A4 | `ANSWER_TOP_K=1 ... --gate` | non-zero exit code |
| A5 | the two exit-code commands | `0` then `1`, no crash |
| A6 | `--tag=out-of-scope` | `➖` on the unmeasured retrieval checks |
| A7 | `EVAL_PACE_MS=0` | `⏳ rate limited ...` lines appear |

---
---

# PART B — Looking inside

## B1. Validate the dataset itself

```bash
cd projects/06-evals
node -e "
import('./evals/golden.js').then(({ validateCases, CASES }) => {
  console.log(validateCases());
  console.log('cases:', CASES.length);
});"
```

**Expect** `{ ok: true, problems: [], count: 18 }`.

**Why this exists:** a broken eval suite reports green while testing nothing, which is
worse than having no suite. So the suite validates its own shape before it runs — for
instance, a case expecting an answer with no `expectedPages` and no `mustContain` is
untestable, because it would pass on *any* answer including a fabricated one.

Break it deliberately: add a case with `expect: 'answer'` and nothing else, and the run
should refuse to start.

## B2. The Unicode normalisation that fixes false failures

```bash
cd projects/06-evals
node -e "
import('./src/metrics.js').then(({ checkStrings }) => {
  const withNarrowSpace = 'Carried-over days expire on 31 March.';
  console.log('looks like:', JSON.stringify(withNarrowSpace));
  console.log('naive includes(\"31 March\"):', withNarrowSpace.includes('31 March'));
  console.log('checkStrings:', checkStrings(withNarrowSpace, { mustContain: ['31 March'] }));
});"
```

**Expect** the naive check to say `false` and `checkStrings` to say `ok: true`.

**This is a real bug the suite hit on its first run.** `U+202F` NARROW NO-BREAK SPACE
looks identical to a space and isn't one. Models emit typographically-correct characters
constantly — narrow spaces in dates, non-breaking hyphens in identifiers, curly quotes
in prose.

## B3. Measure flakiness before trusting any single result

A case that passes 6 times out of 10 isn't a passing case; it's a flaky one, and a flaky
case in a gate teaches people to hit re-run.

```bash
cd projects/06-evals
node --env-file=../../.env --input-type=module -e "
import { answerQuestion } from '../05-retrieval/src/answer.js';
import { pool, listDocuments } from '../05-retrieval/src/db.js';
const docs = await listDocuments();
const hb = docs.find(d => d.filename.includes('acme')).id;
const q = 'How many days of annual leave does a grade 12 employee get?';
let refused = 0;
for (let i = 0; i < 5; i++) {
  const r = await answerQuestion({ question: q, documentId: hb });
  if (!r.grounded) refused++;
  await new Promise(s => setTimeout(s, 1500));
}
console.log('refused ' + refused + '/5 (expected 5/5)');
await pool.end();
"
```

**Expect 5/5.** If you get 3/5, that case belongs in `known-failure` or needs rewriting —
not in a gate.

> This is how `book-altered-quote` was removed from the dataset. It was added because the
> system refused it **once** during manual testing. Re-running it six times gave six
> answers. **A case whose expected outcome came from a single observation is a snapshot,
> not a specification.**

## B4. Validating the judge

```bash
cd projects/06-evals
node -e "
import('./src/judge.js').then(({ judgeAgreement }) => {
  const human = { a: true, b: true, c: false, d: true, e: false };
  const judge = { a: true, b: true, c: true,  d: true, e: false };
  console.log(judgeAgreement(human, judge));
});"
```

**Expect** `agreement: 0.8` and the one disagreement listed.

**The question nobody asks about LLM judges is how you know the judge is any good.** You
label a sample by hand and measure agreement. Below ~0.8 you're adding expensive noise
and the string checks alone would serve you better.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No ingested document for: handbook, book` | database empty — re-ingest (see Setup) |
| `relation "documents" does not exist` | `db:reset` wiped it; re-ingest |
| Every case fails | almost always no data; check `SELECT count(*) FROM chunks` |
| `429 rate limit` with retries | expected — the limiter handles it; raise `EVAL_PACE_MS` to reduce |
| `429` that exhausts all 5 attempts | free-tier TPM is shared across your key; wait a minute |
| Suite passes but you changed something | check you ran against the right document — `--tag` filters hide cases |
| `UV_HANDLE_CLOSING` assertion | `process.exit()` racing the pool close; fixed in `run.js` |
