# Project 04 — Semantic Cache, Spend Limits & Model Routing

**Skill:** making the cost you measured in project 03 smaller — and discovering that the
obvious way to do it is dangerous.

> **Read Part A first.** No jargon. Part B is the same material in professional
> vocabulary. Self-test questions are in `PRACTICE.md` (gitignored).

---
---

# PART A — The plain-English version

> **The cast, if you're jumping in here:** you run a phone hotline. **Customers** call
> you (users in a browser). **You** are the operator — your Node server, the only thing
> that actually does anything. The **expert** is the AI model, locked in a windowless
> room with no internet and no clock, and charging by the minute. The **filing cabinet**
> is your database — only you can walk to it. Full version in project 03's notes.

---

## Problem 1 — The same question, over and over

After a few weeks on the hotline you notice something. Customers keep asking the same
things:

> *"What's your return policy?"*
> *"How do I send something back?"*
> *"Can I return an item?"*

Every single time, you phone the expert and pay by the minute — to get the answer you
already gave twenty minutes ago.

So you start a **box of index cards**. After each call, write the question on one side
and the answer on the other, and file it. Next time, check the box before you pick up
the phone.

That's a cache. Nothing AI about it yet.

## Problem 2 — Filing by wording doesn't work

Here's the snag. If you file cards alphabetically by the words used, *"what's your return
policy"* and *"how do I send something back"* end up in completely different places. You'd
never find the card you need.

An ordinary cache has exactly this problem: it's keyed on the **exact string**. One
different word and it's a miss.

**You need to file by meaning, not by wording.**

## Problem 3 — Filing by meaning: the map

How do you file by meaning? Imagine giving every question a **coordinate on a map**.

Questions about delivery land in one neighbourhood. Questions about refunds land in
another. Two questions that mean the same thing land almost on top of each other, and you
find the card by looking at whatever is nearby.

> **That's an embedding.** A list of numbers — 384 of them here — that positions a piece
> of text on a map of meaning. "How far apart are two questions" is then just measuring
> the distance between two points.
>
> That measurement is called **cosine similarity**, and it runs from about **0**
> (unrelated) to **1** (identical).

The model that produces these coordinates is tiny — 25 MB, running on your laptop in
about 18 milliseconds per question. Embedding models are small; chat models are not.

## Problem 4 — The map lies ⭐

This is the heart of the project, and it is genuinely surprising.

Here are real measurements from the model we're using:

| | Pair | Score |
|---|---|---|
| ✅ | *"What is your return policy?"* ↔ *"How do I return an item?"* | **0.508** |
| ✅ | *"Do you ship internationally?"* ↔ *"Can you deliver abroad?"* | **0.619** |
| ✅ | *"How long does shipping take?"* ↔ *"What are your delivery times?"* | **0.652** |
| ✅ | *"What is the capital of France?"* ↔ *"Which city is France's capital?"* | **0.938** |
| ❌ | *"How do I get a refund?"* ↔ *"How long do refunds take?"* | **0.623** |
| ❌ | *"Is order A-1001 shipped?"* ↔ *"Is order A-2007 shipped?"* | **0.647** |
| ❌ | *"Can I cancel my order?"* ↔ *"Did I cancel my order?"* | **0.839** |
| ❌ | *"Where is my order A-1001?"* ↔ *"Where is my order A-1002?"* | **0.962** |

Read that twice. **The pairs that mean the same thing score LOW. The pair that needs
completely different answers scores the HIGHEST of all — 0.962.**

**Why?** Because the map is built mostly on *surface* similarity, not intent.
*"Where is my order A-1001?"* and *"Where is my order A-1002?"* differ by **one
character** — of course they land on top of each other. Meanwhile *"has my package
shipped"* shares almost no words with *"where is my order"*, so it lands streets away.

Now look at the ranges:

```
✅ SAFE   (should hit):   0.508 ────────────────────── 0.938
❌ DANGER (must miss):          0.623 ─────────────────────── 0.962
                                 └── they overlap almost completely ──┘
```

**There is no cut-off that separates them.**

- Set it at **0.6** and you serve order A-1002's status to the customer asking about A-1001.
- Set it at **0.9** and you catch one genuine paraphrase in four — **and the 0.962
  disaster still gets through.**

> ### Why this is worse than having no cache at all
>
> A wrong cache hit produces a **confident, plausible, completely wrong answer** with no
> error, HTTP 200, and a *lovely* cost saving on your dashboard.
>
> And if the answers contain anything personal — an address, an order total — it's not
> just wrong. It's a **data leak between customers**.
>
> This is the same shape as project 03's clock problem wearing a different hat: the
> failure produces good-looking output, so nothing you'd normally monitor will catch it.

## The fix — three guards, none of which is a threshold

Since similarity can't be trusted alone, you add rules that **overrule the score**.

### Guard 1 — The identifier guard

Pull every identifier-shaped thing out of both questions: order codes, numbers, emails,
anything the customer put in quotes.

**If those don't match exactly, it's a miss — no matter what the score says.**

```
"Where is my order A-1001?"  → identifiers: ["a-1001"]
"Where is my order A-1002?"  → identifiers: ["a-1002"]
                               different → MISS, and the 0.962 never gets a vote
```

This also catches *"your top 5 products"* vs *"your top 10 products"*, which embed at
about 0.95 and obviously need different answers.

### Guard 2 — Never cache a tool-derived answer

The elegant one, and it reaches straight back to project 03.

**If answering required a trip to the filing cabinet, the answer came from live data.**
An order status. A price. Today's date. Caching that means serving a stale fact — and if
the cabinet drawer was that customer's, serving *their* fact to someone else.

**If the expert answered without leaving their chair,** they answered from general
knowledge: a policy, a definition, a fact about the world. That's static and safe to file.

```
"What is your return policy?"   → no tools  → cacheable ✅
"Where is my order A-1001?"     → tool used → NEVER cached ❌
```

Notice this also disposes of *"Can I cancel my order?"* (a policy question, no tools,
cacheable) versus *"Did I cancel my order?"* (needs a tool, never cached) — the 0.839 pair
that no threshold could have separated.

> **`toolsUsed` is a better cacheability signal than anything in the question text.**
> That's the connection between projects 03 and 04.

### Guard 3 — A separate card box per customer

File each customer's cards in their own box. Then even a false hit can only ever serve a
customer *their own* previous answer — never someone else's.

## Problem 5 — Be honest about the hit rate

Add all three guards and something uncomfortable follows: **your cache doesn't hit very
often.**

That's not a bug. Given the overlap above, a cache tuned safely *must* be conservative,
and conservative means missing some genuine paraphrases.

> So when you read *"semantic caching cut our LLM costs 40%"*, there are only three
> possibilities: the workload was genuinely repetitive (a FAQ bot), the threshold was
> loose and they're serving wrong answers they haven't noticed, or they aren't measuring.
>
> **A low hit rate you can trust beats a high one you can't.**

## Problem 6 — The prepaid card

Different problem. One customer discovers they can phone all day, and your bill explodes.

So you give each customer a **prepaid card**. When it's empty, no more expert calls today.

You already know how to do this — it's rate limiting. But here's the twist:

> **Count money, not calls.**

For a normal API every request costs about the same, so "100 requests an hour" genuinely
bounds what someone can consume. For an LLM, one question can cost a **hundred times**
another — a one-line question versus a six-round agent loop resending a growing
conversation. A request limit loose enough to be usable is useless as a spend limit.

### The catch you can't engineer away

**You cannot know what a call costs until it's finished.** Token counts only exist in the
response. So a true pre-authorisation — the way a card payment reserves funds before you
pump the petrol — is impossible.

Three options:

1. Estimate and reserve up front, refund the difference. Accurate, but needs a good
   estimate, refund logic, and a crash leaks the reservation.
2. Check the balance before, record the cost after. Simple. A user can overshoot by at
   most one call.
3. Option 2 plus a concurrency cap, bounding the worst case.

We do **2** and say so. A limit with a known, stated tolerance is more honest than one
that claims to be exact and isn't.

**Measured, with the limit set deliberately low:**

```
call 1  →  HTTP 200
call 2  →  HTTP 429
call 3  →  HTTP 429

final:  spent $0.0000834  against a limit of $0.00005   ← 67% over
```

The limit held — but only *after* the overshoot. Call 1 was allowed because the balance
was fine beforehand, and its cost was only knowable once it finished. That 67% is the
tolerance, and on a real system with concurrent requests it would be larger.

> If someone tells you their LLM spend limit is exact, ask how they authorise a call
> whose cost isn't known until it completes.

## Problem 7 — The junior and the senior expert ⭐

You have two experts on speed dial. A **junior** (cheap, fast, good enough for easy
questions) and a **senior** (expensive, better). Obvious move: ask the junior first, and
escalate if they're unsure.

Obviously cheaper, right?

**Do the arithmetic, because most people don't.**

> **When you escalate, you pay for BOTH calls.**

With junior cost **C**, senior cost **E**, and an escalation rate **r**:

```
routing:              C + r × E
straight to senior:   E

routing wins only when   C + r·E  <  E     →     r  <  1 − C/E
```

Our junior costs half what the senior does, so `C/E = 0.5` and:

> **Routing only saves money if fewer than 50% of questions escalate.**

Above that you are paying for a wasted junior call every single time, and would have been
better off going straight to the senior. Plenty of "cost optimisations" quietly cost money
this way, and nobody notices because nobody measures the escalation rate.

### And how do you know the junior struggled?

We ask it to say so. But **be honest about that signal**: models are frequently
*confidently wrong* — that's the whole lesson of project 03 — so self-reported confidence
is useful, not reliable.

Stronger signals, roughly in order of trustworthiness:

1. **Your own validation failed** — bad schema, missing citation, wrong format
2. **The answer was truncated** (`finish_reason: length`)
3. **A required tool wasn't called** — project 03's detector, reused
4. Self-reported low confidence ← what we use, being the simplest to demonstrate

A real system combines several. Project 06 is where you'd *measure* which of them
actually predicts a bad answer instead of guessing.

### ⭐ What we actually measured — and it's worse than "unreliable"

Costs first, confirming the 2× ratio:

```
forced cheap    $0.0000967
forced strong   $0.0001988      ← 2.06× the cheap one
routed (easy)   $0.0000964      ← took the cheap path, no escalation
```

Then we looked at *when* the junior admits to struggling:

| Question | Escalated? | Outcome |
|---|---|---|
| Trade-offs of optimistic vs pessimistic locking | no | HIGH — answered confidently |
| Prove the Riemann hypothesis | yes | LOW → **HIGH** |
| What is the current price of Bitcoin? | yes | LOW → **HIGH** |
| What did I have for breakfast? | yes | LOW → **LOW** |
| What will the weather be next Tuesday? | yes | LOW → **LOW** |
| "Is it better?" | yes | LOW → **LOW** |

Two things fall out of that, and the second one is the real lesson.

**1. The signal measures the wrong thing.** The junior said HIGH on a genuinely hard
distributed-systems question and LOW on questions it simply lacked facts for. It is
reporting *"do I have the information?"*, not *"is my answer any good?"* — which is
precisely the gap project 03 was about.

**2. Three of five escalations ended LOW → LOW.** We paid for **two** calls and got the
same *"I don't know"* both times.

> **The senior expert doesn't know last Tuesday's weather either.**
>
> Escalating because the model *lacks information* is always wasted money. A bigger model
> has no more access to live data than a small one — those questions need a **tool**, not
> a better model. Escalating because the *reasoning* is hard is the only case where
> paying twice can pay off.
>
> Self-reported confidence conflates the two, which is why it's a poor router on its own.

The sharper design: check whether the question needs live data **first** and route it to a
tool; escalate only on reasoning difficulty. That's a real system's routing policy, and
you'd validate it with evals in project 06 rather than trusting either of us.

---

## Part A summary

| The hotline | Real name | The catch |
|---|---|---|
| Box of index cards | cache | keyed on exact wording, so it rarely hits |
| Filing by meaning | embeddings + cosine similarity | the map measures wording as much as meaning |
| Cards that look alike but aren't | **false cache hit** | 0.962 similar, completely different answers |
| Check the order number matches | identifier guard | overrules the score entirely |
| Never file a cabinet-derived answer | tool-derived → never cache | `toolsUsed` from project 03 |
| One box per customer | per-user namespace | stops cross-customer leaks |
| Prepaid card | spend-based rate limiting | cost is unknown until after the call |
| Junior then senior | model routing | escalation means paying twice — break-even is real |

---
---

# PART B — The professional vocabulary

## 1. Embeddings

A model maps text to a fixed-length vector (384 dimensions here) such that semantically
related text is nearby. `all-MiniLM-L6-v2`, 8-bit quantised, ~25 MB, ~18ms per sentence
on CPU.

**Run embeddings locally.** They're tiny compared to chat models, and in project 05
you'll embed thousands of chunks per document — on a rate-limited free API tier you'd
stall partway through your first ingestion.

**Normalise the vectors** (`normalize: true`) and cosine similarity reduces to a plain
dot product — no square roots, meaningfully faster in a hot loop.

## 2. Semantic caching, and why similarity is not sufficient ⚠️

Measured with this model, the safe range (0.51–0.94) and the dangerous range (0.62–0.96)
overlap almost entirely, and the worst pair scores highest. **No threshold separates
them**, because embeddings encode lexical overlap heavily and `A-1001` vs `A-1002` is a
one-character difference.

Similarity is a **necessary but not sufficient** condition. The guards do the real work:

| Guard | Mechanism | Kills |
|---|---|---|
| Identifier match | regex-extract codes, numbers, emails, quoted strings; exact set equality overrides the score | the 0.962 case |
| Tool-derived → uncacheable | `toolsUsed.length === 0` is the cacheability test | stale/leaked live data, and the 0.839 tense flip |
| Per-user namespace | cache keys scoped by user id | cross-account leakage on any false hit |

**Always record and display what a hit matched against.** A cache you can't audit is a
cache you can't trust — and a wrong hit is otherwise invisible.

## 3. The O(n) admission

> **In Part A terms:** to find a card by *meaning*, you can't flick to a tab. You have to
> take **every card out of the box** and hold it up against the question. With 20 cards
> that's a few seconds. With half a million, you're there all week.

That's literally what `lookup()` does:

```js
for (const id of ids) {                       // every entry in the namespace
  const raw = await client.hGetAll(...);      // ← a round trip to Redis, per entry
  const score = cosine(queryVec, JSON.parse(raw.embedding));
  ...
}
```

### What that looks like on the wire

```
  YOUR SERVER                                            REDIS
       │                                                   │
       ├──── "give me entry #1" ──────────────────────────▶│
       │                    ⏳ waiting ~150 µs              │
       │◀─────────────────── {question, embedding, …} ─────┤
       │  compare  ▪ 2 µs                                  │
       │                                                   │
       ├──── "give me entry #2" ──────────────────────────▶│
       │                    ⏳ waiting ~150 µs              │
       │◀─────────────────── {question, embedding, …} ─────┤
       │  compare  ▪ 2 µs                                  │
       │                                                   │
       ├──── "give me entry #3" ──────────────────────────▶│
       │                       …                           │
       │             × 500 more times                      │
       ▼                                                   ▼
```

**Look at how much of that picture is the word "waiting".**

### Where the time actually goes

People assume the maths is the slow part. It isn't — and knowing which part is slow is
what tells you how to fix it.

```
   ONE ENTRY  =  ~172 µs total

   network  ████████████████████████████████████████████  150 µs   87%
   parse    ██████                                         20 µs   12%
   maths    ▏                                               2 µs    1%
            └──────────────────────────────────────────────┘
              the part everyone worries about is the sliver
```

| Per entry | Roughly | Notes |
|---|---|---|
| 384 multiply-adds (`cosine`) | **~2 µs** | genuinely trivial; CPUs eat this |
| `JSON.parse` of 384 floats | **~20 µs** | 10× the maths, and pure waste |
| **Redis round trip** | **~150 µs** | **75× the maths — this is the bottleneck** |

### How it scales — and where it stops being worth doing

A model call costs about **600 ms**. That's the bar the cache has to beat:

```
 entries                                                    time    verdict
 ─────────────────────────────────────────────────────────────────────────────
     100   ▇                                                 17 ms   ✅ 35× faster
     500   ▇▇▇▇▇                                             85 ms   ✅ 7× faster   ← our cap
   1,000   ▇▇▇▇▇▇▇▇▇▇                                       170 ms   ✅ 3.5× faster
   3,500   ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇           600 ms   ⚠️  break-even
   5,000   ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇  850 ms   ❌ SLOWER than asking
  50,000   ▇▇▇▇▇▇▇▇… (off the chart)                        8.5 s   ❌❌ hopeless
 ─────────────────────────────────────────────────────────────────────────────
                    model call ≈ 600 ms  ────────────────────┘
```

**Somewhere around 3,500 entries the cache becomes slower than the thing it exists to
avoid** — and it still costs you the embedding call on top. That crossover is much earlier
than people expect, which is why "it's only a few hundred entries" is a statement with a
shelf life.

### Fixing it, in order of effort

**1. Pipeline the reads** — cheapest possible win. Instead of 500 sequential round trips,
send all 500 commands at once and read the replies together:

```js
const pipeline = client.multi();
for (const id of ids) pipeline.hGetAll(entryKey(userId, id));
const rows = await pipeline.exec();     // ONE round trip
```

```
  WITHOUT PIPELINING                  WITH PIPELINING
  ──────────────────                  ───────────────
  ask ──▶ ⏳ ──▶ get                   ask ┐
  ask ──▶ ⏳ ──▶ get                   ask │
  ask ──▶ ⏳ ──▶ get                   ask ├──▶ ⏳ once ──▶ get all 500 back
  ask ──▶ ⏳ ──▶ get                   ask │
        … 500 times …                  ask ┘
                                            (500 requests, one wait)
  500 × 150 µs  =  85 ms              1 × 150 µs + work  ≈  5 ms
```

Same algorithm. Same 500 comparisons. **You just stopped paying network latency 500
times** — and it's a ~17× speedup for four lines of code.

> The general lesson, which long outlives this project: when something is slow in a loop,
> check whether you're paying a round trip per iteration before you optimise the
> arithmetic. This is the same bug as an N+1 query in SQL.

**2. Store vectors as binary, not JSON.** A `Float32Array` written as a raw buffer needs
no parsing at all, and is 4 bytes per dimension instead of ~12 characters:

```js
Buffer.from(new Float32Array(vec).buffer)    // 1,536 bytes vs ~4,600 of JSON
```

**3. Use an index.** This is the one that changes the complexity class rather than the
constant factor — and it's worth genuinely understanding rather than treating as magic.

#### First, the card-box picture

```
  WITHOUT AN INDEX — hold up every card
  ┌──────────────────────────────────────────────────────┐
  │  ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤ ▤   │
  │  ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑   │
  │  compare … compare … compare … compare … all of them │
  └──────────────────────────────────────────────────────┘

  WITH AN INDEX — cards grouped, with signposts between groups
  ┌──────────────────────────────────────────────────────┐
  │     [delivery] ──── [returns] ──── [payments]        │  ① pick the
  │          │              │               │            │     neighbourhood
  │       ▤ ▤ ▤ ▤        ▤ ▤ ▤ ▤         ▤ ▤ ▤ ▤         │  ② check ~4 cards
  └──────────────────────────────────────────────────────┘
```

#### Now the real structure: HNSW

**H**ierarchical **N**avigable **S**mall **W**orld. It's a stack of layers — sparse at the
top for long jumps, complete at the bottom.

Imagine meaning laid out along a line, A to W, and we're searching for something near **P**:

```
  LAYER 2   few nodes, huge jumps — "which half of the map?"

     (A)━━━━━━━━━━━━━━━━━━━━━(M)━━━━━━━━━━━━━━━━━━━━━(W)


  LAYER 1   more nodes, medium jumps — "which neighbourhood?"

     (A)━━━━(E)━━━━(I)━━━━(M)━━━━(Q)━━━━(T)━━━━(W)


  LAYER 0   everything, short links — "which exact card?"

     (A)(B)(C)(D)(E)(F)(G)(H)(I)(J)(K)(L)(M)(N)(O)(P)(Q)(R)(S)(T)(U)(V)(W)
```

**Searching for P:**

```
  ① LAYER 2 — start anywhere, say (A)
       compare A, M, W  ······················· 3 comparisons
       M is closest to P  →  stand on M
                    │
                    ▼  descend
  ② LAYER 1 — from (M), look at its neighbours
       compare I, Q  ·························· 2 comparisons
       Q is closest to P  →  stand on Q
                    │
                    ▼  descend
  ③ LAYER 0 — from (Q), look at its neighbours
       compare P, R  ·························· 2 comparisons
       P wins ✓
                                               ─────────────
                                                7 comparisons
                                                (not 23)
```

You skipped A–O entirely. **You never even looked at most of the box.**

That ratio is the whole point, and it gets better as the box grows:

```
  entries        full scan        HNSW (roughly)
  ─────────────────────────────────────────────────
        23              23                  7
     1,000           1,000                ~30
    50,000          50,000                ~50
 1,000,000       1,000,000                ~60     ← barely moved
```

Full scan grows **linearly**. HNSW grows **logarithmically** — which is why a million
vectors is a normal Tuesday for a vector database and impossible for our loop.

#### ⚠️ The catch: it's approximate

The **A** in ANN — *approximate* nearest neighbour — is doing real work.

```
     (A)━━━━━━━━━━━━━━━━━━━━━(M)━━━━━━━━━━━━━━━━━━━━━(W)
      ↑
      └── suppose the TRUE best match for P was hiding back here.

  We jumped to M on step ① and never returned. We'd never find it.
```

You are trading **recall** (did I find the genuinely closest one?) for speed. Tunable —
HNSW has knobs like `ef_search` that widen the search and cost more time — but never zero.

> **For a cache that's a fine trade:** a missed match means one extra model call, which is
> exactly what would have happened without a cache.
>
> **For project 05's retrieval it matters more:** a missed chunk means the answer is
> generated without the paragraph that contained the truth. Same structure, higher stakes
> — which is why project 06 measures retrieval quality separately from answer quality.

#### The commands

You don't build any of that yourself. You declare the index and the database maintains it:

```
FT.CREATE idx ON HASH PREFIX 1 cache:e:
  SCHEMA embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE
                          ─┬──                 ─┬──        ─┬──    ──────┬──────
                           │                    │           │            │
              build an HNSW index    32-bit floats    384 dims    cosine distance

FT.SEARCH idx "*=>[KNN 5 @embedding $vec AS score]" PARAMS 2 vec <bytes>
                     ──┬──
                       └── "give me the 5 nearest to $vec"
```

**One command replaces the entire loop.** No round trip per entry, no `JSON.parse`, no
`for`. Redis walks the layers internally and hands back the 5 nearest. Roughly O(log n)
instead of O(n).

pgvector is the same idea with SQL syntax — you'll write it in project 05:

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

SELECT text FROM chunks ORDER BY embedding <=> $1 LIMIT 5;
--                                        ─┬─
--                                         └── cosine distance operator
```

**We hand-roll the loop because the arithmetic is the lesson.** Once you've written
`cosine()` yourself, an index stops being magic — it's just a faster way to run the
comparison you already understand. Project 05 uses a real index (pgvector HNSW) at a
scale that genuinely demands one.

---

## 4. Redis configuration that matters

```
redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru --save ""
```

Three settings. Each one prevents a specific, real failure.

> **In Part A terms:** your index-card box sits on a shelf. The shelf is a fixed size.
> What happens when the box is full? And do you photocopy the whole box every night?

### `--maxmemory 128mb` — how big the box is

Without it, Redis grows until the container (or the machine) runs out of memory and the
OOM killer takes it. **An unbounded cache is a memory leak with good PR.**

### `--maxmemory-policy allkeys-lru` — what to do when the box is full ⚠️

This is the one that bites people, because **the default is wrong for a cache**:

| Policy | Behaviour when full |
|---|---|
| **`noeviction`** ← **THE DEFAULT** | **refuses writes.** `OOM command not allowed when used memory > 'maxmemory'` |
| `allkeys-lru` | evict least *recently* used — good general cache default |
| `allkeys-lfu` | evict least *frequently* used — better when a small set is very hot |
| `volatile-lru` | evict LRU, but **only keys that have a TTL** |
| `allkeys-random` | evict at random — cheap, surprisingly not terrible |

> **The landmine:** set `maxmemory` and forget the policy, and your cache silently stops
> accepting new entries the moment it fills. Reads keep working, so it looks healthy —
> your hit rate just quietly decays toward zero as the cached answers go stale. People
> discover this in production.

**`volatile-*` vs `allkeys-*`** matters if one Redis holds both cache entries and things
you can't lose. `volatile-lru` only evicts keys you gave a TTL, protecting the rest. But
the better answer is usually **separate instances** — mixing the two is how you end up
wanting a policy that's right for both, which doesn't exist.

**The distinction to actually hold on to:**

```
Cache      allkeys-lru is CORRECT.      Losing an entry = one extra model call.
Database   allkeys-lru is CATASTROPHIC. Redis silently deletes your data.
```

Same software, opposite correct setting. **The policy encodes what you think Redis is
for** — and being able to say that in an interview is worth more than memorising the list.

You can watch it working:

```bash
docker exec -it ai-learning-redis redis-cli INFO stats | grep evicted_keys
```

### `--save ""` — don't photocopy the box every night

Disables RDB snapshots. Two reasons:

**1. It costs something.** Snapshotting forks the process and writes to disk. For data
that's worthless after a restart, that's pure overhead.

**2. Persistence actively hides bugs in development.** Here's the concrete one:

> You change `EMBEDDING_MODEL` to a different model. The new model produces vectors that
> mean something *different* — possibly a different number of dimensions entirely.
>
> With persistence on, yesterday's vectors are still in the box. Your cosine scores are
> now comparing coordinates from two different maps, and the numbers that come out are
> **meaningless but not obviously wrong** — just slightly worse hit rates and the odd
> bizarre match.
>
> With `--save ""`, restarting gives you a clean box and the problem cannot occur.

**This is a real invalidation trap**, not a hypothetical: a cached vector is only
comparable to vectors from the *same model*. If you ever change embedding models in
production, **every stored vector must be recomputed or discarded.**

### And `mem_limit: 192m` in the compose file

Belt and braces. Redis's `maxmemory` counts *your data*, not its own overhead — buffers,
replication backlog, fragmentation. The container limit catches the rest, so a
miscalculation can't take your editor down with it on an 8 GB machine.

---

## 5. Spend-based rate limiting

> **In Part A terms:** every customer gets a prepaid card. When it's empty, no more calls
> to the expert today. You already know how to build this — it's rate limiting — but with
> money in the counter instead of requests.

### The key design: `budget:{user}:{date}`

```js
const key = (userId) => `budget:${userId}:${new Date().toISOString().slice(0,10)}`;
//                       budget:u_1:2026-09-15
```

Putting the **date in the key** is doing more work than it looks:

- The window **resets for free** at midnight — a new date means a new key, starting at 0.
- Old keys **expire themselves** via the TTL. No cron job, no nightly "delete rows older
  than" query, no cleanup code to forget about.
- Yesterday's spend is still inspectable until it expires, which is handy for debugging.

**This is a fixed-window counter.** Worth knowing the alternatives and why we picked it:

| Approach | How | Trade-off |
|---|---|---|
| **Fixed window** ← ours | one counter per period | simplest; allows a burst at the boundary |
| Sliding window | sorted set of timestamped spends, sum the last 24h | accurate, no boundary burst; more memory and more commands |
| Token bucket | refill at a steady rate | smooth, good for sustained-rate limits; awkward for "per day" budgets |

**The fixed-window flaw:** a user can spend their entire budget at 23:59 and the whole
thing again at 00:01 — double the intended daily spend in two minutes. For a *request*
limit that's a real problem. For a daily *cost* cap it's usually acceptable, and saying
"we accept boundary bursts" is better than not knowing the flaw exists.

### Why `INCRBYFLOAT` and not read-modify-write

Here's the bug you avoid. Suppose you did it the obvious way:

```js
const spent = Number(await client.get(key));   // both read 0.004000
await client.set(key, spent + cost);           // both write 0.005000
```

Two concurrent requests, each costing $0.001:

```
request A:  reads 0.004000  ──┐
request B:  reads 0.004000  ──┤ both saw the same value
request A:  writes 0.005000   │
request B:  writes 0.005000  ─┘ ← A's spend VANISHED
```

You charged for one call and recorded one. `INCRBYFLOAT` is a **single atomic operation**
inside Redis — no read step for anyone to interleave with:

```js
await client.incrByFloat(key, usd);            // 0.004 → 0.005 → 0.006
```

> **Production note:** floats drift. `INCRBYFLOAT` uses long double internally, which is
> fine at this scale, but real billing systems store **integers** — micro-dollars via
> `INCRBY`, formatted for display — so repeated addition can never accumulate error.

### The race that remains, and its size

Atomic *recording* doesn't make the *check* atomic:

```
request A:  check → $0.009 spent of $0.010, allowed  ──┐
request B:  check → $0.009 spent of $0.010, allowed  ──┤ neither has recorded yet
request A:  costs $0.004, records → $0.013             │
request B:  costs $0.004, records → $0.017            ─┘ ← 70% over the limit
```

With **N concurrent requests, the worst-case overshoot is N calls.** We measured 67% over
with a single sequential request; concurrency makes it worse in proportion.

The fixes, and why we didn't:

1. **Concurrency cap per user** — a semaphore allowing one in-flight call each. Bounds the
   overshoot to exactly one call. Cheap, and what I'd add first in production.
2. **Reserve-then-refund** — estimate the cost, `INCRBYFLOAT` it up front, refund the
   difference after. Accurate, but needs a decent estimator and refund logic, and a crash
   between the two leaks the reservation permanently.
3. **Lua script** — do check-and-increment atomically inside Redis. Solves the race, but
   still can't know the cost before the call, so it only helps once you're reserving.

> **The unavoidable core:** you cannot pre-authorise an LLM call, because its cost doesn't
> exist until it finishes. Everything above is about bounding the overshoot, never
> eliminating it. A limit with a **stated tolerance** is honest; one claiming to be exact
> is wrong.

### Return 429, not 403

**403 Forbidden** means "you may not do this" — a permissions decision, permanent.
**429 Too Many Requests** means "not right now" — a rate limit, and it resets.

Clients treat them completely differently: a 403 is a bug to report, a 429 is a signal to
back off and retry later. Getting this wrong sends users to support for something that
would have fixed itself.

And send the header that tells them *when*:

```js
res.writeHead(429, {
  'Retry-After': secondsUntilMidnightUTC(),   // e.g. 14400
  'Content-Type': 'application/json',
});
```

### What per-user limits don't cover

A per-user cap stops one customer bankrupting you. It doesn't stop **ten thousand**
customers each spending their full allowance on the day your app gets popular.

Production wants both: a per-user limit *and* a **global circuit breaker** — total spend
per hour across all users, which trips and degrades the service rather than letting the
bill run. Same Redis, one more counter, no user id in the key.

## 6. Model routing break-even

```
routing cost = C + r·E        worth it iff   r < 1 − C/E
```

Track the escalation rate as a first-class metric. Track **cost per completed answer**,
never cost per call — same lesson as project 03's "is the cheap model actually cheaper".

When escalating, **re-ask cleanly** rather than showing the strong model the weak model's
attempt. A wrong first answer anchors the second, and you paid more for a worse result.

## 7. Cache invalidation

TTL on every entry, even "static" answers — policies change. The harder cases (a policy
document is edited; a price changes) need explicit invalidation keyed on the source data,
which is a real design problem and not one a TTL solves.

---

## Experiments to actually run

```bash
npm run redis:up --workspace=04-semantic-cache      # ~15 MB
npm run dev      --workspace=04-semantic-cache      # http://localhost:8790
```

Full walkthrough in `TESTING.md`. The two that matter most:

- Ask **"Where is my order A-1001?"**, then **"Where is my order A-1002?"**. Watch the
  identifier guard block a 0.96 match and explain why.
- Ask **"What is your return policy?"** then **"How do I return an item?"**. At the
  default 0.85 threshold this *misses* (they score 0.508) — the honest cost of safety.
  Drop `CACHE_THRESHOLD` to 0.5 and it hits, but now re-run the A-1001/A-1002 pair and
  see what else you let in.

That second experiment is the project. There is no setting that gives you both.

---

## Self-test

`PRACTICE.md` (gitignored). Topics: what an embedding is, why high similarity can mean
danger, the three guards, why hit rates are honestly low, why you count money not
requests, why exact pre-authorisation is impossible, and the routing break-even formula.

---

## What carries into project 05

Everything here is the foundation of RAG, at a smaller scale. Semantic caching asks
*"has someone asked this before?"*; retrieval asks *"which paragraph of this book is
closest to this question?"* — same embeddings, same cosine similarity, same Redis. The
only change is what you search over, and the move from an O(n) loop to a real index.

The guards carry over too. A retrieval system that returns a confidently similar but
wrong passage is the same failure as a false cache hit.
