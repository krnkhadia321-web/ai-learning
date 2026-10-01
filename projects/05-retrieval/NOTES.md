# Project 05 — Retrieval (RAG) over your own documents

**Skill:** answering questions from a document you supply — and refusing everything else,
verifiably rather than hopefully.

> **Read Part A first.** No jargon. Part B is the same material in professional
> vocabulary. Self-test questions are in `PRACTICE.md` (gitignored).

---
---

# PART A — The plain-English version

> **The cast, if you're jumping in here:** you run a phone hotline. A **customer** calls
> (a user in a browser). **You** are the operator — your Node server, the only thing that
> actually does anything. The **expert** is the AI model, locked in a windowless room:
> no internet, no database, no clock, charging by the minute. Full version in project 03's
> notes.

---

## The setup: the expert has never read your handbook

A customer asks: *"How many days of annual leave do I get on grade 7?"*

The expert is brilliant and has read most of the internet. But they have **never seen
your company's handbook** — it's not on the internet, it's a PDF on your laptop.

So you do the obvious thing: **you slide the relevant pages under the door along with
the question.**

> *"Here's the question. Here are three pages from the handbook. Answer using only these."*

**That's RAG** — Retrieval-Augmented Generation. Retrieve the relevant bit, hand it over,
generate an answer from it. The whole field is that one sentence plus the problems below.

---

## Problem 1 — You can't slide the whole book under the door

Why not just hand over all 300 pages?

- **It won't fit.** There's a limit to how much you can give the expert at once.
- **It's expensive.** You pay per page handed over, every single time.
- **It makes the answer worse.** Bury the one relevant paragraph in 300 pages and the
  expert skims and misses it — the same way you would.

So you must **find the right pages first**. That's **retrieval**, and it's most of the work.

## Problem 2 — Finding the right pages: index cards, again

You already know how to do this from project 04. **Give every passage a coordinate on
the map of meaning**, then find the ones nearest the question.

The only change from project 04 is *what's on the cards*:

| | Project 04 | Project 05 |
|---|---|---|
| One card per… | question someone asked before | paragraph of the document |
| You search for… | "has anyone asked this?" | "which paragraph is about this?" |
| Mechanism | embeddings + cosine similarity | **identical** |

Same model, same arithmetic. The only real difference is scale — thousands of cards
instead of hundreds — which is why this project uses a **real index** (HNSW in Postgres)
rather than project 04's loop over everything.

## Problem 3 — Where do you cut the book into cards? ⭐

Here's a question that sounds trivial and isn't. **This matters more than which database
you choose**, and gets a fraction of the attention.

### Why not one card per page?

Because one card gets **one coordinate**. A page covering leave, expenses and parking
averages out to a point in the middle of nowhere, close to nothing in particular. Ask
about leave and it matches weakly, because only a third of it is about leave.

**Smaller pieces = sharper points on the map.**

### But small hurts too

```
   TOO SMALL                           TOO BIG
   "receives 22 days of annual leave"  a whole page about everything
            ▲                                    ▲
   22 days of WHICH GRADE?             the coordinate is mush, retrieval
   Retrieves perfectly.                 gets vague, and you pay for
   Answers nothing.                     irrelevant text on every question
```

### And the boundary lands wherever it lands

```
   card 1: "... Annual leave entitlement depends on employment grade."
   card 2: "A grade 5 employee receives 22 days ..."
                    ↑ split here
```

Neither card answers the question well. The first has the topic, the second has a bare
number with no context.

**So cards overlap.** Each one repeats a sentence or two of the previous card, so the
boundary effectively falls in two places and at least one card holds the whole fact.

### And you cut at sensible places

The naive version — *"every 500 characters"* — slices mid-word and mid-sentence,
producing fragments that match badly and read worse when shown to a user as evidence.

So we cut at the **most natural break available**, in order of preference:

```
   paragraph  →  line  →  sentence  →  word  →  (only if desperate) character
```

> **A small win worth noticing:** a heading like `SECTION 2: ANNUAL LEAVE` is its own
> paragraph and ~24 characters — useless as a card on its own. We glue it onto the text
> beneath it, which makes that card *better* than the text alone, because the heading
> tells the map what the passage is about.

## Problem 4 — Two ways to find a card, each blind where the other sees

**By meaning** (the map) and **by exact words** (an index at the back of the book).

They fail in exactly opposite directions:

| Question | By meaning | By exact words |
|---|---|---|
| *"holiday allowance"* | ✅ finds "annual leave entitlement" | ❌ nothing — those words aren't in the book |
| *"SEC-0001"* | ❌ happily returns SEC-0042 | ✅ exact match, no ambiguity |

**That second row is the same trap as project 04's `A-1001` vs `A-1002`.** To the map,
two reference codes mean almost exactly the same thing — they're both "a reference code".
And reference codes, section numbers, product names and error codes are *precisely* what
people search for.

**So you use both.** That's **hybrid search**.

## Problem 5 — Combining two rankings ⭐

Now you have two lists of cards, and you need one. The obvious move — add the scores —
**doesn't work**, because the two scores aren't on the same scale at all:

```
   by meaning:      0.0 → 2.0     (lower is better)
   by exact words:  0.0 → ~1.0    (higher is better, and the range shifts per query)
```

Adding those is meaningless. Normalising them is fragile.

**So ignore the scores and use the positions.** A card that's 1st on one list and 3rd on
the other is clearly good, whatever the numbers say:

```
   score = 1/(60 + position on list A)  +  1/(60 + position on list B)
```

That's **Reciprocal Rank Fusion**. The 60 flattens the gap between 1st and 2nd, so no
single list can dominate — **agreement between the two methods is what wins**.

## Problem 6 — The expert answers anyway ⭐⭐

**This is the one you asked for, and it's the hardest.**

You slide over three pages and say *"only use these."* The expert has read most of the
internet and has opinions about annual leave regardless. If your pages don't cover the
question, a confident, plausible, **completely invented** answer comes back under the door.

> Same shape as project 03's clock, in new clothes: fluent output, no error, nothing to
> alert on, and it came from training data rather than from your document.

**Writing "only use these pages" in the prompt is a request, not a control** — exactly
like project 02's "only show the user their own orders", which a user could talk the
model out of in one sentence.

### Four locks, two of which the expert cannot pick

**🔒 Lock 1 — The gate: don't even ask.**

Before calling the expert at all, check whether *anything retrieved is actually relevant*.
If the best card scores below a threshold, refuse immediately.

**No pages handed over, no opportunity to improvise, and it costs nothing** — no model
call happens at all. Measured: `$0.0000000`.

**🔒 Lock 2 — A form, not an essay.**

The expert must fill in a form with a box that says **"were these pages enough?"**

```json
{ "sufficient_context": true|false, "answer": "...", "citations": [1, 2] }
```

That makes *"I can't answer this from the document"* a **first-class result** you can
branch on — rather than something you hope appears somewhere in the prose.

**🔒 Lock 3 — Cite your pages, and I'll check.**

Every answer must name which pages it used. Then **your code verifies those pages were
actually in what you handed over.** A citation to a page you never supplied means it
invented the citation — and almost certainly the answer with it.

**🔒 Lock 4 — Do the cited pages actually say that?**

Pull the hard facts out of the answer — numbers, codes, times — and check each one
appears in a cited passage. "22 days" versus "28 days" is a one-token difference with
completely different consequences, and this catches it for free on every request.

> **Locks 1 and 3 are code.** The model has no say in either. Locks 2 and 4 depend on the
> model behaving, which is why they're the *inner* layers rather than the outer ones.

### What it looks like when it works

Measured on the sample handbook:

```
  ✅ "annual leave for grade 7?"      → "28 days", cites page 2       $0.0001608
  ✅ "meal allowance internationally" → "4500 rupees/day", page 3     $0.0001810

  🛑 "how do I configure Redis?"      → gated at 0.217                $0.0000000
  🛑 "capital of France?"             → gated at 0.022                $0.0000000

  ⚠️ "annual leave for grade 12?"     → gate PASSED, model refused:
       "the passages only specify grades 5, 7 and 9"                  $0.0001896
```

**That last one is the interesting case.** "Grade 12" is textually almost identical to the
grade 5/7/9 lines, so it sailed through the similarity gate — exactly the near-duplicate
problem from project 04. **Lock 1 couldn't catch it. Lock 2 did.**

That's why you layer them. No single mechanism is sufficient.

## Problem 7 — The photocopier is terrible ⚠️

One more, and it will annoy you more than any AI part of this.

**A PDF does not contain paragraphs, sentences, or reliably even words.** It contains
instructions like *"draw the letter A at position (72, 410)"*. Extracting text means
looking at thousands of positioned marks and **guessing** where the words and lines were.

Which goes wrong in ways you won't notice until you inspect the output:

- **two-column layouts** get read straight across, interleaving both columns
- **tables** collapse into a soup of numbers with the structure gone
- **headers and footers** repeat on every page and pollute every single card
- **hyphenated line breaks** split words: "entitle-" / "ment"
- **ligatures** — PDFs store "fi" as one glyph "ﬁ", so searching for "find" fails
- ⚠️ **scanned PDFs contain no text at all.** They are photographs.

We handle the first five and **fail loudly** on the last. Silently indexing nothing is
how you spend an hour debugging retrieval when the real problem was that there was never
any text:

```
Almost no text could be extracted. This is very likely a SCANNED PDF — a stack of
images rather than text. Reading it would need OCR (Tesseract), which this project
does not do.
```

---

## Part A summary

| The hotline | Real name | The catch |
|---|---|---|
| Slide the right pages under the door | **RAG** | you have to find them first |
| One card per paragraph | **chunking** | matters more than the database |
| Cards overlap | **chunk overlap** | so a fact isn't split across a boundary |
| By meaning / by exact words | **vector / keyword search** | each blind where the other sees |
| Merge two lists by position | **Reciprocal Rank Fusion** | scores aren't comparable; ranks are |
| Don't ask if nothing is relevant | **retrieval gate** | refuses for free, no model call |
| A form with "were these enough?" | **structured output** | refusal becomes a first-class result |
| Name your pages, I'll check | **citation validation** | the model can't pick this lock |
| The photocopier is terrible | **PDF extraction** | the ugliest part of the whole project |

---
---

# PART B — The professional vocabulary

## 1. The pipeline

```
   PDF ─▶ extract ─▶ assess ─▶ de-header ─▶ chunk ─▶ embed ─▶ store
                                                                 │
   question ─▶ embed ─▶ hybrid search ─▶ gate ─▶ LLM ─▶ validate ◀┘
```

## 2. Why Postgres, not a vector database

You need vector **and** keyword search. Postgres does both: `pgvector` for similarity,
built-in `tsvector`/`ts_rank` for full text. One system, one source of truth, one
transaction.

A dedicated vector DB means running a second database, syncing it with Postgres, and
still needing Postgres for the documents. **"You probably don't need a vector database"
is the current consensus under a few million vectors** — and being able to argue it is
worth more than knowing a vendor's API.

## 3. The schema is the design

```sql
embedding vector(384)   -- similarity search
tsv       tsvector      -- keyword search, GENERATED so it can never drift
page      int           -- citations ← the column that makes grounding verifiable
checksum  text UNIQUE   -- re-ingest protection
```

Two indexes, one per search method:

```sql
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);  -- ANN, ~O(log n)
CREATE INDEX ... USING gin  (tsv);                          -- inverted index
```

⚠️ The HNSW operator class **must match the query operator**. Build for cosine
(`vector_cosine_ops`) and query with `<=>`. Mismatch them and Postgres silently ignores
the index — correct-looking results, terrible performance, no error.

**`checksum` is not optional.** Re-ingest the same file and you silently double every
chunk; duplicates then crowd out genuinely different passages, degrading retrieval in a
way that's very hard to notice.

## 4. ⭐ The bug: `plainto_tsquery` ANDs everything

The measured one, and it's invisible without looking.

```
plainto_tsquery('how many days of annual leave does a grade 7 employee get')
  →  'mani' & 'day' & 'annual' & 'leav' & 'grade' & '7' & 'employe' & 'get'
```

Every term, ANDed. A chunk must contain *all* of them — including "many" and "get", which
appear in no handbook passage.

**Result: zero rows on every natural-language question.** The keyword half of our hybrid
search contributed **nothing at all**, and the bug was invisible because the vector half
still returned plausible results.

The fix is BM25-style OR semantics — match any term, rank higher for matching more:

```sql
to_tsquery('english',
  NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | '), ''))
```

`to_tsvector` stems and drops stop-words; joining with `|` makes it a disjunction;
`ts_rank` does the ranking. `NULLIF` guards the all-stop-words case — a NULL tsquery
matches nothing instead of raising a syntax error.

> **The general lesson:** a hybrid system where one half silently contributes nothing
> still returns results. Test each retriever **in isolation** — which is why `/v1/search`
> exists as a separate endpoint.

## 5. Reciprocal Rank Fusion

```sql
COALESCE(1.0/(60 + v.rank), 0) + COALESCE(1.0/(60 + k.rank), 0)
```

Fuse by **rank**, never by score — cosine distance and `ts_rank` live on unrelated scales
and their distributions shift per query. `FULL OUTER JOIN`, not inner: a chunk found by
only one method is exactly the material the other is blind to.

Retrieve **more candidates than you return** (20 → 5). A chunk ranked 15th by vectors and
2nd by keywords deserves a chance, and only sees one if both lists are deep enough.

## 6. Chunking parameters

| Parameter | Default | Effect |
|---|---|---|
| `CHUNK_SIZE` | 500 chars | smaller = sharper but less context |
| `CHUNK_OVERLAP` | 100 chars | insurance against boundary splits |
| `minSize` | 80 chars | below this, merge into the neighbour |

Characters, not tokens — a rough proxy (~4 chars/token) you can reason about directly.
Recursive splitting on `\n\n` → `\n` → `. ` → ` ` → character.

## 7. Grounding, in order of strength

| Mechanism | Can the model defeat it? |
|---|---|
| Retrieval gate, before the call | **No** — it never runs |
| Citation id validation | **No** — your code checks against what you supplied |
| `sufficient_context` field | Yes, if it lies |
| Fact-appears-in-citation check | Yes, for paraphrased claims |

Gate on **semantic similarity**, not the RRF score. RRF is a fusion *rank* — its absolute
value says nothing about whether anything is relevant, only about ordering within this
query. An irrelevant question still has a top-ranked chunk; it just has a dreadful
similarity.

⚠️ **The fact-check is a heuristic, not proof.** It can't check a paraphrase with no
numbers, and a number can appear while meaning something else. Proper groundedness
scoring uses a judge model over (claim, passage) pairs — that's project 06.

## 8. PDF extraction

`pdfjs-dist/legacy/build/pdf.mjs` — the legacy build; the default expects browser APIs.

Lines are reconstructed from `transform[5]` (vertical position): a jump of more than ~2pt
means a new line, because the PDF has no line breaks of its own.

Then clean: ligatures (`ﬁ` → `fi`), hyphenated line breaks, collapsed whitespace. Detect
lines repeating on >60% of pages and strip them as running headers.

**Assess before indexing.** <200 chars total → almost certainly scanned. Fail with an
explanation rather than building an index over nothing.

---

## Experiments to actually run

```bash
npm run db:up --workspace=05-retrieval      # postgres + redis
npm run dev   --workspace=05-retrieval      # http://localhost:8791
```

Full walkthrough in `TESTING.md`. The three that matter:

1. **Ask the grade 12 question.** It passes the similarity gate and gets refused by the
   model anyway. That's why the locks are layered.
2. **Search `SEC-0001` on the Retrieval tab.** Watch keyword search nail it and vector
   search drift. Then search *"holiday allowance for senior staff"* and watch the
   reverse. Neither alone is enough.
3. **Set `MIN_SIMILARITY=0.6` and re-run the grounded questions.** They start getting
   refused. Set it to `0.05` and out-of-scope questions start reaching the model. Same
   trade as project 04's cache threshold, same conclusion: **no single number is right**,
   which is why there are four locks and not one.

---

## Self-test

`PRACTICE.md` (gitignored). Topics: why you can't hand over the whole document, the
chunk-size trade-off, why overlap exists, the two search methods and their blind spots,
why RRF fuses by rank, the four grounding mechanisms and which two are code, and why
scanned PDFs must fail loudly.

---

## ⭐ Problem 8 — Two questions in one, and the limit of this design

Found by testing on a real 347-page book rather than the 4-page sample. **It is a genuine
limitation, not a bug**, and it's the most useful thing this project taught.

Ask a question whose answer lives in two distant places:

> *"What does the author say about both the monkey mind **and** about reprogramming your
> brain like software?"*

It gets **refused** — *"the passages do not contain any mention of the monkey mind"*. Which
is simply untrue: page 35 says exactly that, and asking about the monkey mind alone finds
it immediately.

**Each half works. The combination doesn't:**

```
  monkey mind alone      → pages  35, 35, 35, 36, 33       ✓
  software alone         → pages  234, 39, 234, 9, 103     ✓
  COMBINED               → pages  234, 234, 39, 9, 39      ✗  page 35 gone

  "what happened to Ali"           → pages  7, 312, 154, 320, 237    ✓
  "how suffering changed his view" → pages  82, 22, 15, 288, 5       ✓
  COMBINED                         → pages  142, 288, 335, 177, 240  ✗  neither half
```

### Why

**One question becomes one embedding — one point on the map.** A two-topic question
averages both topics, and an average lands *between* them, near neither:

```
     monkey mind ●                                    ● software
                        ○ ← the combined query lands here, and the
                            nearest chunks are whatever generic
                            "mind/suffering" prose sits in the middle
```

In the second case it landed in a region of general "suffering and meaning" material and
retrieved five chunks of that instead — pages **neither** sub-query had found.

### The part that matters

**The system failed safely.** Handed only software passages, it refused rather than
inventing a monkey-mind claim. **Grounding worked perfectly; retrieval was the weak link.**

Which is precisely why `/v1/search` exposes retrieval on its own, and why project 06
scores retrieval quality *separately* from answer quality. From the answer alone, "the
book doesn't say that" and "we failed to find where the book says that" are
indistinguishable — and they have completely different fixes.

**The fixes:** *query decomposition* — have the model split a compound question into
sub-queries, retrieve for each, answer over the union. And *reranking* — a cross-encoder
scores each candidate against the **full question text** rather than comparing two
averaged vectors, so it can recognise a passage that satisfies one half.

> **The rule: a single query embedding cannot retrieve for two distinct topics at once.**

## ⭐ Problem 9 — The gate scales inversely with document breadth

Also only visible with two documents of different sizes. Compare *which* lock caught each
out-of-scope question:

| | 4-page handbook | 347-page book |
|---|---|---|
| Caught by **Lock 1** (gate — free, no model call) | most refusals | **only "configure Redis"** |
| Caught by **Lock 2** (the model) | the grade-12 trap | **everything else** |

On a **narrow** document, nearly any off-topic question scores badly, so the gate catches
it for nothing. On a **broad** book about the mind, almost any question about thoughts,
habits, anxiety or routines has something semantically nearby — so the gate waves it
through and the structured-output lock does all the work.

The gate cannot tell *"this book discusses morning routines"* from *"this book describes a
**five-step** morning routine"*. Only something that has read the passages can.

> **This is the argument for layering rather than tuning.** Neither lock is sufficient,
> and which one carries the load depends on the document — so there is no single
> configuration to get right.

## What carries into project 06

You now have a system that refuses — but **how do you know it refuses the right things?**
Every claim in this file was checked by hand on seven questions. That doesn't scale, and
it doesn't catch a regression three weeks from now when you change the chunk size.

Project 06 is **evals**: a golden set of questions with known answers, a judge that scores
groundedness automatically, and a CI gate that fails the build when retrieval quality
drops. It's the difference between "it worked when I tried it" and "it still works".
