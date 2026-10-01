# Project 05 — Testing guide

Every feature built in this project, with what to click and what you should see.

## ⚠️ Windows: use Git Bash, not PowerShell

**Run every command in this file in Git Bash.** In VS Code: the `+` dropdown at the top
right of the terminal panel → **Git Bash**.

In PowerShell, `curl` is an **alias for `Invoke-WebRequest`** — a different program. You
get errors like `Missing an argument for parameter 'SessionVariable'`.

| Git Bash | PowerShell |
|---|---|
| `curl` | **`curl.exe`** |
| `VAR=x node ...` | `$env:VAR='x'; node ...` |
| `A && B` | `A; if ($?) { B }` |

---

# Setup

**1. Start the databases** (Postgres + pgvector, and Redis carried over from project 04):

```bash
npm run db:up --workspace=05-retrieval
docker ps --filter name=ai-learning --format "{{.Names}}  {{.Status}}"
```

Expect `ai-learning-postgres` and `ai-learning-redis` both `Up`. Postgres takes ~2s to
become ready the first time.

**2. Generate the sample document** — 4 pages of known facts, so you can tell retrieval
from invention:

```bash
cd projects/05-retrieval
node scripts/make-sample-pdf.js
```

**3. Ingest it:**

```bash
npm run ingest --workspace=05-retrieval
```

Expect:

```
▸ reading acme-handbook.pdf
  4 pages, 2,451 chars (~613/page)
  8 chunks (target 500 chars, overlap 100, actual avg 348)
  embedding 8 chunks…
✓ ingested in 1.3s — 8 chunks across 4 pages
```

**4. Start the server:**

```bash
npm run dev --workspace=05-retrieval
```

```
▸ retrieval server on http://localhost:8791
▸ postgres ready — 1 document(s), 8 chunk(s)
▸ embedding model ready: Xenova/all-MiniLM-L6-v2 (384 dims)
▸ gate: refuse below similarity 0.25, top-k 5
```

---
---

# PART A — Browser walkthrough

Open **http://localhost:8791**. Three tabs: **Ask**, **Retrieval**, **Documents**.

---

## A1. A grounded answer with citations

Click the first example — *"How many days of annual leave does a grade 7 employee get?"*

**Expect** a green card:

```
✅ grounded          720ms · $0.0001608 · best similarity 0.862

28 days

CITED PASSAGES — CHECK THEM YOURSELF
  page 2 · passage 1
  SECTION 2: ANNUAL LEAVE  Annual leave entitlement depends on employment
  grade. A grade 5 employee receives 22 days... A grade 7 employee receives 28 days...

fact check: all_facts_appear_in_citations (1 checked)
```

**Proves:** the answer came from the document, and you can verify it without trusting
anything — the cited page is shown right there.

> **Open `docs/acme-handbook.pdf` and check page 2 yourself.** That's the entire point.
> An answer you can trace to a page beats a confident answer you can't.

Scroll down to **What was retrieved** — all 5 candidate chunks with their similarity and
which method found them.

---

## A2. ⭐ Out of scope — refused for free

Click *"How do I configure Redis maxmemory policy?"*

**Expect** an amber card:

```
🛑 refused — below_similarity_gate     0ms · $0.0000000 · no model call — free

I can't answer that from this document. The closest passage scored 0.217,
below the 0.25 relevance threshold.
```

**Look at the cost: `$0.0000000`.** The model was never called. Nothing was handed over,
so there was no opportunity to improvise.

Try *"What is the capital of France?"* too — scores **0.022**, a far more obvious miss.

**Proves:** Lock 1. The gate is code; the model gets no say.

---

## A3. ⭐⭐ The trap — where the gate fails and the next lock catches it

Click *"How many days of annual leave does a grade 12 employee get?"*

The document covers grades **5, 7 and 9**. There is no grade 12.

**Expect** an amber card — but read the reason carefully:

```
🛑 refused — model_said_insufficient      $0.0001896

The passages only specify annual leave for grades 5, 7, and 9; they do not
provide the entitlement for grade 12.
```

**Note what's different from A2:**

| | A2 (Redis) | A3 (grade 12) |
|---|---|---|
| Reason | `below_similarity_gate` | `model_said_insufficient` |
| Cost | **$0.0000000** | $0.0001896 |
| Caught by | **Lock 1** (code) | **Lock 2** (the model) |

**Why the gate failed:** "grade 12 annual leave" is textually almost identical to the
grade 5/7/9 lines. It scored *well above* 0.25 — exactly the near-duplicate problem from
project 04, where `A-1001` and `A-1002` scored 0.962.

**This is the single most important test in the project.** It shows why one mechanism is
never enough, and why the locks are layered rather than chosen.

Also try *"What is the dental insurance policy?"* — plausible topic for a handbook, not
in this one. Gated at 0.191.

---

## A4. Hybrid retrieval — each method's blind spot

Switch to the **Retrieval** tab. No model is involved here at all.

**Search `SEC-0001`** (an incident ticket format on page 4):

```
Vector only     p4  p4  p1  p2       ← drifts; to an embedding one code
                                        looks much like another
Keyword only    p4                   ← exact match, nothing else
Hybrid (RRF)    p4 (both)  p4  p1    ← the agreed hit on top
```

**Now search *"holiday allowance for senior staff"*** — words that appear **nowhere** in
the document:

```
Vector only     p2 ...               ← finds "annual leave entitlement" anyway
Keyword only    (few or none)        ← the words aren't there
```

**Proves:** vectors find meaning and miss exact tokens; keywords find exact tokens and
miss meaning. Neither alone is sufficient, which is the whole argument for hybrid.

---

## A5. Upload your own PDF

Switch to **Documents**. Drag a PDF onto the drop zone (or click to browse).

**Expect** a green card with the ingestion log — pages, chunk count, embedding time.

**Three things to try:**

| Do this | Expect |
|---|---|
| Upload the **same file twice** | *"already ingested — skipped to avoid duplicate chunks"* |
| Upload a **.txt** renamed | `Only .pdf files are supported.` |
| Upload a **scanned PDF** | a clear explanation, not a 500 — see A6 |

Then go back to **Ask**, pick your document in the dropdown, and ask it something.

> **Tell me what document you uploaded** and I'll write test questions for it — including
> deliberate traps, which are the ones worth having.

---

## A6. The scanned-PDF failure

The most common real-world ingestion failure, and it must fail **loudly**.

```bash
# make a valid PDF with pages but no text — structurally like a scan
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
const o=[]; const ids=[4,6,8];
o[1]='<< /Type /Catalog /Pages 2 0 R >>';
o[2]='<< /Type /Pages /Kids ['+ids.map(i=>i+' 0 R').join(' ')+'] /Count 3 >>';
o[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
for (const id of ids){
  o[id]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents '+(id+1)+' 0 R >>';
  o[id+1]='<< /Length 0 >>\nstream\n\nendstream'; }
let p='%PDF-1.4\n'; const f=[];
for(let i=1;i<o.length;i++){ if(!o[i])continue; f[i]=Buffer.byteLength(p,'latin1'); p+=i+' 0 obj\n'+o[i]+'\nendobj\n'; }
const x=Buffer.byteLength(p,'latin1');
p+='xref\n0 '+o.length+'\n0000000000 65535 f \n';
for(let i=1;i<o.length;i++) p+=String(f[i]??0).padStart(10,'0')+' 00000 n \n';
p+='trailer\n<< /Size '+o.length+' /Root 1 0 R >>\nstartxref\n'+x+'\n%%EOF\n';
writeFileSync('docs/scanned-like.pdf', Buffer.from(p,'latin1'));
console.log('made a valid 3-page PDF with zero text');
"
```

Upload `docs/scanned-like.pdf` in the browser.

**Expect:**

```
✗ could not ingest

Almost no text could be extracted. This is very likely a SCANNED PDF — a stack
of images rather than text. Reading it would need OCR (Tesseract), which this
project does not do.
```

**Proves:** the assessment step. Without it you'd ingest 300 empty pages, build an index
over nothing, and spend an hour debugging retrieval when the real problem was that there
was never any text.

---

## A7. ⭐ Prove no single threshold works

The experiment that makes the design land. Restart with a strict gate:

```bash
cd projects/05-retrieval
MIN_SIMILARITY=0.6 node --env-file=../../.env src/server.js
```

Re-run **A1** (grade 7 leave). It scored 0.862, so it still works. Now try:

```
"How long do I have to return my laptop after leaving?"
"What is the meal allowance when travelling internationally?"
```

**Some genuine questions now get refused** — the document answers them, but the
similarity didn't clear 0.6.

Now go the other way:

```bash
MIN_SIMILARITY=0.05 node --env-file=../../.env src/server.js
```

Re-run **A2** (Redis config, scored 0.217). **It now reaches the model** — you're handing
irrelevant handbook passages to an LLM and asking it about Redis. Watch whether Lock 2
saves you. Sometimes it will. That's not a guarantee.

**Proves:** tightening the gate refuses real questions; loosening it lets nonsense
through. **There is no single correct value** — which is exactly why there are four locks
and not one. Same conclusion as project 04's cache threshold.

**Restart at the default afterwards.**

---

## Browser checklist

| # | Do | Pass if |
|---|---|---|
| A1 | grade 7 leave | ✅ "28 days", cites page 2, fact check passes |
| A2 | Redis config | 🛑 `below_similarity_gate`, **$0.0000000** |
| A3 | grade 12 leave | 🛑 `model_said_insufficient` — different lock, non-zero cost |
| A4 | `SEC-0001`, then "holiday allowance" | each method wins one, loses the other |
| A5 | upload a PDF twice | second time: *already ingested* |
| A6 | upload the textless PDF | clear scanned-PDF explanation, not a 500 |
| A7 | `MIN_SIMILARITY` 0.6 then 0.05 | real questions refused / nonsense gets through |

---
---

# PART B — Command line

```bash
ask() { curl -s -X POST http://localhost:8791/v1/ask -H 'Content-Type: application/json' \
  -d "{\"question\":\"$1\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
console.log((r.grounded?' ✅':' 🛑'), (r.reason??r.support?.verdict??'').padEnd(30), '\$'+(r.costUsd||0).toFixed(7));
console.log('   ', JSON.stringify(r.answer.slice(0,100)));
if(r.citations?.length) console.log('    pages:', r.citations.map(c=>c.page).join(', '));});"; }
```

**Paste that into your terminal first.** Shell functions live only in the terminal that
defined them.

## 1. Health and config

```bash
curl -s http://localhost:8791/healthz
```

**Expect:** document and chunk counts, `unembedded: "0"`, and the live config —
`MIN_SIMILARITY`, `TOP_K`, chunk size and overlap.

`unembedded` should always be `0`. Anything else means an ingestion failed halfway, which
the transaction in `ingest.js` is supposed to prevent.

## 2. The full grounded/refused sweep

```bash
ask "How many days of annual leave does a grade 7 employee get?"
ask "What is the meal allowance when travelling internationally?"
ask "How long do I have to return my laptop after leaving?"
ask "How do I configure Redis maxmemory policy?"
ask "What is the capital of France?"
ask "How many days of annual leave does a grade 12 employee get?"
ask "What is the dental insurance policy?"
```

**Expect exactly this shape** — three answered, four refused, and note *which* refusals
cost nothing:

```
 ✅ all_facts_appear_in_citations   $0.0001608    "28 days"              pages: 2
 ✅ all_facts_appear_in_citations   $0.0001810    "...4500 rupees..."    pages: 3
 ✅ all_facts_appear_in_citations   $0.0001815    "...5 working days..." pages: 4
 🛑 below_similarity_gate           $0.0000000
 🛑 below_similarity_gate           $0.0000000
 🛑 model_said_insufficient         $0.0001896    "...only specify grades 5, 7, and 9..."
 🛑 below_similarity_gate           $0.0000000
```

## 3. Retrieval in isolation

```bash
curl -s -X POST http://localhost:8791/v1/search -H 'Content-Type: application/json' \
  -d '{"query":"SEC-0001","limit":3}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
for (const m of ['vector','keyword','hybrid'])
  console.log(m.padEnd(9), r[m].map(x=>'p'+x.page+'/'+x.foundBy).join(' ') || '(none)');});"
```

**Why this endpoint exists separately:** when an answer is wrong you must know whether
**retrieval** failed or **reasoning** did. Those have completely different fixes, and the
answer alone can't tell you.

## 4. ⭐ Reproduce the `plainto_tsquery` bug

The bug that made keyword search silently return nothing:

```bash
docker exec ai-learning-postgres psql -U rag -d rag -t -c "
SELECT 'ANDed  → ' || plainto_tsquery('english','how many days of annual leave does a grade 7 employee get')::text;
SELECT 'ORed   → ' || array_to_string(tsvector_to_array(to_tsvector('english','how many days of annual leave does a grade 7 employee get')), ' | ');"
```

**Expect:**

```
ANDed  → 'mani' & 'day' & 'annual' & 'leav' & 'grade' & '7' & 'employe' & 'get'
ORed   → 7 | annual | day | employe | get | grade | leav | mani
```

**The AND version requires every term**, including "many" and "get" — which appear in no
handbook passage. Zero rows, on every natural question, while the vector half kept
returning plausible results and hid the failure completely.

## 5. Inspect the database directly

```bash
docker exec -it ai-learning-postgres psql -U rag -d rag
```

```sql
\dt                                    -- tables
\d chunks                              -- see the generated tsv column
SELECT page, chunk_index, length(text) FROM chunks ORDER BY chunk_index;
SELECT page, left(text,60) FROM chunks WHERE text ILIKE '%grade 7%';

-- the HNSW index in use
EXPLAIN ANALYZE SELECT id FROM chunks ORDER BY embedding <=> (SELECT embedding FROM chunks LIMIT 1) LIMIT 5;

\q
```

**In the EXPLAIN output**, look for `Index Scan using chunks_embedding_idx`. A
`Seq Scan` means the index isn't being used — usually an operator-class mismatch, and
with 8 rows Postgres may legitimately choose a sequential scan anyway.

## 6. Chunking parameters

```bash
cd projects/05-retrieval
CHUNK_SIZE=200 CHUNK_OVERLAP=40 node --env-file=../../.env src/ingest.js docs/acme-handbook.pdf
```

The checksum will skip it. To genuinely re-chunk, wipe and re-ingest:

```bash
docker exec ai-learning-postgres psql -U rag -d rag -c "TRUNCATE documents CASCADE;"
CHUNK_SIZE=200 CHUNK_OVERLAP=40 node --env-file=../../.env src/ingest.js docs/acme-handbook.pdf
```

**Expect** many more, smaller chunks. Then re-run the A1 question and see whether the
answer still has enough context — smaller chunks retrieve more sharply but may lose the
grade/number pairing.

**Reset:** `TRUNCATE documents CASCADE;` then ingest at the defaults.

---

---
---

# PART C — Testing against a real book

Everything above uses the 4-page sample handbook. **A real document behaves differently**,
and the differences are the interesting part.

Worked example: *That Little Voice In Your Head* (Mo Gawdat, 2022) — **347 pages,
1,380 chunks, ingested in 28 seconds** (24s of that embedding, locally, for free).

> That number is the argument for local embeddings in one line. 1,380 calls to a
> rate-limited free API tier would have stalled partway through.

Adapt the question categories below to whatever you ingest. The **categories** are the
reusable part, not the specific questions.

## C1. The seven categories worth testing

| Category | Why | Example (book) |
|---|---|---|
| **Core concept** | should answer | *"What does the author mean when he says you are not the voice in your head?"* |
| **Specific personal detail** | should answer, easy to verify | *"What happened to the author's son Ali?"* |
| **Obviously foreign** | should be **gated** | *"How do I configure Redis maxmemory?"* |
| **Wrong proper noun** | one character off something real | *"What does the author say about his son **Omar**?"* |
| **Invented structure** | presupposes a list that doesn't exist | *"What are the author's **seven** types of inner voice?"* |
| **Plausible but absent** | topically adjacent, genuinely not covered | *"What does the author say about the **ketogenic diet**?"* |
| **Wrong attribution** | a real book/person the author didn't discuss | *"What does he say about **The Untethered Soul**?"* |

**Measured — 11/11 behaved correctly:**

```
✅ "you are not the voice"            cites pp. 35, 36      sim 0.650
✅ "the code that runs your brain"    cites pp. 234, 10, 9  sim 0.606
✅ "what happened to Ali"             cites pp. 312, 237    sim 0.657

🛑 Redis config                       gated at 0.138        $0.0000000
🛑 HTTP 429                           model refused
🛑 "his son Omar"                     model refused
🛑 "seven types of inner voice"       "they only discuss inner speech in general
                                       without listing specific categories"
🛑 "five-step morning routine"        model refused
🛑 SSRI dosage                        model refused
🛑 The Untethered Soul                model refused
🛑 ketogenic diet                     model refused
```

## C2. ⭐ The gate scales inversely with document breadth

**The most important difference from the handbook.** Look at *which lock* caught each trap:

| | 4-page handbook | 347-page book |
|---|---|---|
| Caught by **Lock 1** (gate, free) | most refusals | **only Redis** |
| Caught by **Lock 2** (model) | the grade-12 trap | **everything else** |

On a narrow document, almost any off-topic question scores badly and the gate catches it
for free. On a broad book about the mind, *almost any* question about thoughts, anxiety,
habits or routines has something semantically nearby — so the gate passes it, and the
structured-output lock does nearly all the work.

The gate cannot distinguish *"this book discusses morning routines"* from *"this book
describes a **five-step** morning routine"*. Only something that has read the passages can.

> **This is the argument for layering rather than tuning.** Neither lock is sufficient,
> and which one carries the load depends on the document — so you can't pick one.

## C3. ⭐ The altered-quote trap — run it with its control

The best single test in this file, because it isolates one changed word.

Find a real, specific detail in your document, then ask about a version with **one thing
altered** — and ask the true version too, as a control. Without the control you can't tell
a correct refusal from a system that refuses everything.

**Measured:**

```
🛑 "Pink Floyd's 'Comfortably Numb'"   → refused
✅ "Pink Floyd's 'Brain Damage'"       → answered, cites pp. 35, 34     ← control

🛑 "what does HINDUISM call the voice" → refused
✅ "what do Buddhism and Islam call it"→ "Islam calls it the whispers, and Buddhism
                                          calls it the monkey mind"  p. 35  ← control

🛑 "I always KNEW it was me"           → "The passages state that the author thought
                                          the voice was him ('I always thought it was
                                          me'), but they do not explain what he means
                                          by 'knew'"
```

**That last one is the best result in the project.** The model didn't just refuse — it
**quoted the real text back to correct the false premise**. That is only possible if it
genuinely read the passage rather than pattern-matching a refusal.

> Verify the control answers by hand. The Buddhism/Islam one is checkable against page 35
> in under a minute, and *checking* is the entire point.

## C4. ⭐⭐ Multi-hop: where this system genuinely fails

**The real limitation, reproducible, and it is a retrieval failure — not a grounding one.**

Ask a question whose answer lives in two distant places:

```
"What does the author say about both the monkey mind AND about
 reprogramming your brain like software?"
```

**Expect it to be REFUSED** — *"the passages do not contain any mention of the monkey
mind"*. Which is false: page 35 says exactly that, and C3's control proves it retrieves
fine on its own.

**Prove the diagnosis — ask each half separately** (Retrieval tab, or `/v1/search`):

```
  monkey mind alone      → pages  35, 35, 35, 36, 33       ✓ found
  software alone         → pages  234, 39, 234, 9, 103     ✓ found
  COMBINED               → pages  234, 234, 39, 9, 39      ✗ page 35 GONE
```

And a second case, which is worse:

```
  "what happened to Ali"           → pages  7, 312, 154, 320, 237    ✓
  "how suffering changed his view" → pages  82, 22, 15, 288, 5       ✓
  COMBINED                         → pages  142, 288, 335, 177, 240  ✗
```

**The combined query retrieved pages that NEITHER sub-query found.**

### Why this happens

One question becomes **one embedding** — a single point on the map of meaning. A
two-topic question averages both topics, and the average lands **between** them:

```
        monkey mind ●                                   ● software
                          ○ ← the combined query lands here,
                              near neither, and nearest to whatever
                              generic "mind/suffering" material sits
                              in the middle
```

In the second case it landed in a region of generic "suffering and meaning" prose and
retrieved five chunks about that instead.

### What this tells you, and what fixes it

**The system failed safely.** Given only software passages, it refused rather than
inventing a monkey-mind claim. Grounding worked perfectly; **retrieval was the weak link** —
which is exactly why `/v1/search` exists, and why project 06 scores retrieval quality
*separately* from answer quality.

The fix is **query decomposition**: have the model split a multi-part question into
sub-queries, retrieve for each, merge the results, then answer over the union. Also worth
knowing: **reranking** (a cross-encoder scoring each candidate against the full question,
rather than comparing two averaged vectors) helps here too.

> **The rule:** a single query embedding cannot retrieve for two distinct topics at once.
> If your users ask compound questions, you need to decompose them.

## C5. Your own document — a 10-minute checklist

1. Ingest it. Note the chunk count and embedding time.
2. Pick **three facts you know are in it** → all three should answer with citations you
   can check by opening the page.
3. **Open one cited page and read it.** Don't skip this. A correct-looking answer with a
   real citation can still be a bad compression of what the page says.
4. Ask **two obviously foreign** questions → expect gating at **$0.0000000**.
5. Ask **one wrong proper noun** and **one invented structure** → expect refusals with
   *specific* reasons, not generic ones.
6. Run **one altered-quote trap with its control** (C3).
7. Run **one multi-hop question** (C4) and check whether it finds both halves.

> ⚠️ **Expect `no_checkable_facts` on prose.** The fact-check only verifies numbers and
> codes. A book answers mostly in sentences, so that verdict is honest rather than a
> failure — it's saying *"I had nothing mechanical to check"*, not *"everything is fine"*.

---
---

## Shut down

```bash
npm run db:down --workspace=05-retrieval        # keeps the volume
npm run db:reset --workspace=05-retrieval       # DELETES all ingested data
```

The Postgres volume persists deliberately — re-ingesting a large book takes minutes.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Postgres unreachable` | `npm run db:up --workspace=05-retrieval` |
| `relation "chunks" does not exist` | schema not initialised — restart the server, it runs `initSchema()` |
| Everything refuses | check `MIN_SIMILARITY` in `/healthz`; also confirm a document is actually ingested |
| Keyword search returns nothing | the `plainto_tsquery` trap — see Part B §4 |
| Ingestion says "already ingested" | same file contents; `TRUNCATE documents CASCADE;` to start over |
| Upload rejected as scanned | it genuinely has no text layer; needs OCR, which this project doesn't do |
| `port 5432 already in use` | we use **5433** on the host for exactly this reason — check your compose file |
