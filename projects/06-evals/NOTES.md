# Project 06 — Evals

**Skill:** knowing whether your AI system still works — automatically, repeatably, and
without you choosing the questions.

> **Read Part A first.** No jargon. Part B is the same material in professional
> vocabulary. Self-test questions are in `PRACTICE.md` (gitignored).

---
---

# PART A — The plain-English version

> **The cast, if you're jumping in here:** you run a phone hotline. A **customer** calls.
> **You** are the operator — your Node server. The **expert** is the AI model, locked in
> a windowless room, charging by the minute. The **filing cabinet** is your document.
> Project 05 built the bit where you slide the right pages under the door.

---

## Problem 1 — "It worked when I tried it"

Project 05 ended with twenty questions checked by hand. They passed. Job done?

**No.** Four things are wrong with that, and the fourth is the worst.

1. **You only check what you remember to check.** Twenty questions out of thousands.
2. **You check right after changing something**, when you're paying attention. Nobody
   re-checks three weeks later.
3. **It doesn't scale.** Twenty by hand is an afternoon. Two hundred is a week.
4. ⭐ **You chose the questions** — and you chose ones you expected to pass.

That fourth one isn't hypothetical. In project 05 I wrote the hybrid-search test, picked
queries where hybrid won, and concluded hybrid wins. **The first query you picked
yourself** — *"holiday allowance for senior staff"* — found a case where hybrid was
*worse* than vector search alone.

I wasn't being careless. That's just what happens when the person who built a thing also
picks the test cases.

## Problem 2 — The mystery shopper

So you hire a **mystery shopper**: a fixed list of questions with **known-correct
answers**, called in on a schedule.

What makes it work, and spot-checking not:

| | Spot-checking | Mystery shopper |
|---|---|---|
| Who picks the questions? | you, each time | decided once, written down |
| Same questions every time? | no | **yes** — so you can compare |
| Happens when you're not looking? | no | yes |
| Checks the impossible ones? | rarely | **always** |

> **That last row matters more than it looks.** The list must include questions the
> document genuinely cannot answer, so you can check the operator says *"I don't know"*
> rather than inventing something. A shopper who only asks answerable questions tests
> half the job.

That list is your **golden dataset**, and it's the whole project.

## Problem 3 — Every question needs a checkable outcome

*"The answer looked reasonable"* is not a test. A machine can't run it, and neither can
you three weeks later.

So each question carries what to check:

```
  question         "How many days of annual leave does a grade 7 employee get?"
  should it        answer
  which page       page 2
  must contain     "28"
  must NOT contain "22 days", "32 days"      ← the half people forget
```

**`must NOT contain` is the important one.** That paragraph lists grades 5, 7 *and* 9 —
22, 28 and 32 days. An answer of *"22 or 28 days depending on grade"* contains "28" and
is still wrong. Checking only for the right answer passes answers that are also wrong.

## Problem 4 — Two scores, never one ⭐⭐

**The central idea of this whole project.**

The shopper checks **two separate things**:

```
  1. Did the operator find the right page?           ← RETRIEVAL
  2. Given that page, did they read it correctly?    ← ANSWERING
```

Why separate? Because project 05 proved they fail **independently**:

```
  the multi-hop question:

     retrieval   ❌  page 35 was never found
     answering   ✅  given only the wrong pages, it refused rather than inventing
```

A single *"accuracy: 60%"* hides that completely. And the two have **completely
different fixes**:

| What broke | Where the fix lives |
|---|---|
| Retrieval | chunking, how you handle the query, reranking |
| Answering | the prompt, the model, the output contract |

> From the final answer alone, *"the document doesn't say that"* and *"we failed to find
> where the document says it"* look identical. Only separate scores tell them apart.

## Problem 5 — Two kinds of mistake, and they aren't equal

Lay out what can go wrong:

```
                          should ANSWER        should REFUSE
      answered            ✅ correct           ❌ FALSE ACCEPT
      refused             ❌ false refusal     ✅ correct
```

**False accept** — it answered something it should have refused. That's a confident
wrong answer reaching a customer. **This is the one that hurts.**

**False refusal** — it refused something it could have answered. Annoying. Makes the
product feel useless. **But nobody is misled.**

They are not equally bad, so they don't get equal tolerance. Our gate allows **0%** false
accepts and **20%** false refusals.

And here's the part that makes this a real engineering problem rather than a dial to
turn: **they move in opposite directions.** Tighten the gate and false refusals rise.
Loosen it and false accepts rise. See Problem 9, where this is measured rather than
argued.

## Problem 6 — A trap without a control is not a test

Suppose you add a trick question — a quote with one word changed — and the system
refuses it. Success?

**You've learned nothing.** A system that refuses *everything* also passes that test.

So every trap needs its **control**: the true version of the same question, which must
be *answered*.

```
  🛑 "What does he say about Pink Floyd's 'Comfortably Numb'?"   → must REFUSE
  ✅ "What does he say about Pink Floyd's 'Brain Damage'?"       → must ANSWER
```

The **pair** is the test. Either one alone proves nothing.

## Problem 7 — Hiring a second expert to grade the first

Some things can't be checked by looking for a string. *"Is every claim in this answer
actually supported by the page it cited?"* needs reading comprehension.

So you hire a **second expert** to grade the first one's work against the source.

> ⚠️ **Be suspicious of this.** You are using an AI to grade an AI. That's circular, and
> it's the weakest part of the project.
>
> Judges are known to prefer longer answers, prefer their own family's writing, and lean
> towards saying "yes, that's supported" unless you make them work for it.

Four rules, all applied here:

1. **Use the judge as little as possible.** "Was page 35 retrieved?" needs no judge and
   cannot be wrong. Save it for what string matching genuinely can't do.
2. **Give it the narrowest possible job.** Not *"is this a good answer"* but *"is this
   specific sentence supported by this specific passage — yes or no, and quote the
   words."*
3. **Give it the source text.** A judge without the passages is just a second opinion
   from training data, which is the exact thing you're testing against.
4. ⭐ **Check the judge.** Label twenty cases by hand and measure agreement. Below ~80%
   you're adding expensive noise. There's a helper for this in `judge.js`.

**And it costs.** Measured: judge `$0.0019`, system `$0.0019`. **The judge roughly
doubles the price of a run.**

## Problem 8 — Writing down what you've accepted

Project 05 found a real failure: multi-hop questions retrieve only one half.

Three options: pretend it isn't there, fail the suite forever, or **write it down**.

A **known failure** is a case marked *"we expect this to fail, for this documented
reason."* The suite still passes, reports the failure every run — and **tells you loudly
if it starts passing**, because then someone fixed something and the case should be
promoted to a normal one.

> ⚠️ But known failures are excluded from the **pass count**, not from the **rates**.
> Our false-refusal rate is **20% with them, 0% without**. Both numbers are true and
> they answer different questions:
>
> - **with** = what the system actually does today. The gate judges this, because
>   customers experience the known failures too.
> - **without** = how it does on everything not already accepted as broken. This is what
>   tells you whether a *change* made things worse.
>
> Report one without the other and you either hide real failures or bury a new
> regression inside a number people have learned to ignore.

## Problem 9 — Measuring the trade-off instead of arguing about it ⭐⭐

Projects 04 and 05 both said *"no single threshold works"*, both from a handful of
examples. Time to actually measure it.

**The trick that makes it cheap:** the gate is a comparison — `similarity < threshold`.
So run the suite **once** with the gate switched off, record each question's similarity
and what the expert decided, then **replay** every threshold as arithmetic. One
expensive pass; the whole curve free, and deterministic.

Sorting the cases by similarity is where it gets interesting:

```
    0.851  should ANSWER   leave-grade7
    0.806  should refuse   trap-grade12          ← second from the top
    0.683  should ANSWER   carry-over-expiry
    0.681  should ANSWER   book-control-song
    0.650  should ANSWER   book-not-the-voice
    0.644  should ANSWER   meal-international
    0.548  should ANSWER   laptop-return
    0.533  should ANSWER   overtime-holiday
    0.513  should ANSWER   book-monkey-mind
    0.465  should refuse   book-wrong-son
```

**A threshold is a horizontal line through that list.** Everything below it is refused,
regardless of merit.

Now look at `trap-grade12` at **0.806** — a question that must be refused, ranked above
**seven** questions that must be answered.

> **Any gate strict enough to catch it blocks all seven.**
> **Any gate loose enough to let them through lets it through too.**
>
> That is not a tuning problem. It is **structural**. No number exists.

And yet the system gets **0% false accepts at every threshold**. Why?

**Because the expert caught it, not the gate.** The cheap uncheatable filter cannot
separate those cases, so the expensive fallible one has to.

That's the layered-locks argument from project 05 — finally measured rather than
asserted.

## Problem 10 — The shop doesn't open if the score drops

A report nobody reads changes nothing. The last step is making it **block**.

Every run ends with a pass/fail against fixed limits, and an **exit code**. Wire that
into CI and a change that makes retrieval worse cannot be merged.

> **Set the limits just below where you are now.** A bar you already clear catches
> regressions. An aspirational bar means a permanently red build, which everyone learns
> to ignore — the same as having no gate at all.
>
> Then tighten it when you improve. It's a **ratchet**, not a target.

---

## Part A summary

| The mystery shopper | Real name | Why |
|---|---|---|
| Fixed list of questions with known answers | **golden dataset** | you can't grade what you didn't decide in advance |
| Questions the document can't answer | **out-of-scope cases** | half the job is saying "I don't know" |
| "Must not contain 22 days" | **negative assertions** | catches the near-miss answer |
| Did they find the page? / did they read it right? | **retrieval vs answer metrics** | they fail independently, different fixes |
| Answered when it should refuse | **false accept** | the one that hurts |
| Refused when it could answer | **false refusal** | annoying, but safe |
| Every trick question needs a true twin | **control case** | else "refuses everything" passes |
| Second expert grades the first | **LLM-as-judge** | for what strings can't check — and treat it with suspicion |
| Written-down accepted failures | **known failures** | tracked, excluded from pass rate, NOT from the rates |
| Replaying every threshold from one run | **sweep** | turns "no number works" into a curve |
| The shop doesn't open | **CI gate** | a report that can't block changes nothing |

---
---

# PART B — The professional vocabulary

## 1. Metrics, and which need a model

| Metric | What it answers | Needs a judge? |
|---|---|---|
| **Recall@k** | was an expected page retrieved at all? | no |
| **MRR** | how high was the first correct one? (rank 1 = 1.0) | no |
| **Coverage** | what fraction of expected pages were found? | no |
| **Behaviour** | answered vs refused, against expectation | no |
| **String assertions** | must/must-not contain | no |
| **Groundedness** | is every claim supported by the cited passage? | **yes** |
| **Refusal validity** | was refusing justified given what was retrieved? | **yes** |

**Do as much as possible deterministically.** It's free, instant, and cannot be wrong.

**Recall vs MRR:** recall@5 scores "rank 1" and "rank 5" identically. MRR doesn't. A
change that moves the right passage from 4th to 1st is a real improvement that recall
alone reports as flat.

## 2. The confusion matrix

```
                     should ANSWER        should REFUSE
    answered         correct              FALSE ACCEPT
    refused          false refusal        correct
```

`falseAcceptRate = false_accept / (should refuse)`
`falseRefusalRate = false_refusal / (should answer)`

Asymmetric tolerance, because the costs are asymmetric: gate at **0%** false accept,
**20%** false refusal.

## 3. Gate thresholds are a ratchet

Set just below current performance. Tighten after improving. Never aspirational — a
permanently failing gate gets disabled, and a disabled gate is worse than none because
it looks like coverage.

The exit code is the mechanism: `process.exitCode = 1` on failure, and CI does the rest.

## 4. ⚠️ LLM-as-judge: known biases

Self-preference, verbosity bias, position bias, leniency, correlated errors with the
system under test. Mitigations used here: a stronger judge model, per-claim breakdown
rather than a single score, the score derived from the breakdown arithmetically, source
text always provided, and `judgeAgreement()` for validating against human labels.

**A judge you haven't validated is a number you haven't earned.**

## 5. ⭐ The sweep: replay, don't re-run

The gate is `similarity < threshold`. Record one pass with the gate disabled, then
simulate each threshold offline. 12 thresholds for the price of 1, and deterministic —
so the curve's shape is signal, not noise.

**Interleaving** is the key output: a should-refuse case ranked above a should-answer
case is unseparable by any threshold. Compute it; don't make the reader spot it.

---

## ⭐ What building this suite taught — five real bugs

Every one of these was found by the suite misbehaving, and each is a general lesson.

### 1. String matching needs Unicode normalisation

First run reported:

```
carry-over-expiry  · answer missing: 31 March
                     answer: "...expire on 31 March."
```

The answer plainly contains it. Inspecting code points found **U+202F NARROW NO-BREAK
SPACE** between "31" and "March". Models emit typographically-correct characters —
narrow spaces in dates, non-breaking hyphens in identifiers, curly quotes in prose. All
look identical; none compare equal.

NFKC fixes most spaces but **not** dashes (`U+2011` → `U+2010`, still not ASCII), so
those need explicit replacement.

> **A false failure is expensive in a different way from a false pass: it teaches you to
> ignore the suite.**

### 2. A case derived from one observation is a snapshot, not a spec

`book-altered-quote` was added because the system refused it once during manual testing.
Re-running it **6 times gave 6 answers** — and the answers were defensible.

**If you can't say why an outcome is correct without pointing at a previous run, the
case isn't ready.** Replaced with an unambiguous pair (wrong song vs right song),
verified 4/4 and 4/4 before being written down.

### 3. Eval suites are bursty and will hit rate limits normal usage never does

Run 1 died at case 13: `429 ... tokens per minute: Limit 8000`. A human clicking around
sends one request every few seconds; a suite sends 17 back to back, each with five
passages plus a judge call.

Fixed with project 01's tools: retry on 429 honouring the provider's stated delay, full
jitter, plus a pace between cases. **The limit is on tokens, not requests** — fewer,
fatter calls don't help.

### 4. Reporting that invites a false conclusion

The report said *"+2 known failures, excluded"* then printed one set of rates that
**included** them. Recall read 80%, driven entirely by the excluded cases.

Not wrong exactly — which is what made it dangerous. Now both columns are printed with
an explicit note on which the gate judges.

### 5. `process.exit()` races your cleanup

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
```

`process.exit()` terminates immediately, so the `finally` closing the Postgres pool never
completed and Node crashed. **Set `process.exitCode` and let the process end naturally.**

---

## Experiments to actually run

```bash
npm run db:up --workspace=05-retrieval    # the system under test needs its database
npm run eval  --workspace=06-evals        # full suite
npm run eval:sweep --workspace=06-evals   # ⭐ the threshold curve
```

Full walkthrough in `TESTING.md`. The two that matter: the **sweep** (for the
interleaving output), and **deliberately breaking something** in project 05 to watch the
gate catch it.

---

## Self-test

`PRACTICE.md` (gitignored). Topics: why spot-checking fails, what makes a case
checkable, why retrieval and answering are scored separately, the two error types and
their asymmetry, why traps need controls, judge biases and how to validate one, known
failures and the two-column reporting, and why the sweep can replay instead of re-run.

---

## What carries into project 07

You can now measure whether a change helped. That's the prerequisite for changing
anything with confidence — including the fixes project 05 identified but never built
(query decomposition, reranking). Both are now **measurable**: implement one, run the
sweep, and see whether the known-failure cases flip to passing.
