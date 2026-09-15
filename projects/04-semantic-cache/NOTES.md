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

`lookup()` compares the query against every entry in the namespace, one Redis round trip
each. At 500 entries that's a few milliseconds; at 500,000 it's hopeless.

Production uses an **approximate nearest neighbour index**. In Redis that's vector sets or
RediSearch:

```
FT.CREATE idx ON HASH PREFIX 1 cache:e:
  SCHEMA embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE

FT.SEARCH idx "*=>[KNN 5 @embedding $vec AS score]" PARAMS 2 vec <bytes>
```

We hand-roll the loop because the arithmetic is the lesson. Project 05 uses a real index
(pgvector HNSW) where the scale demands one.

## 4. Redis configuration that matters

```
--maxmemory 128mb --maxmemory-policy allkeys-lru --save ""
```

`allkeys-lru` evicts least-recently-used keys at the limit — correct for a cache, and
**catastrophic for a database**. Knowing which of those two you're running is the whole
point of the setting. `--save ""` disables persistence: nothing here is worth surviving a
restart.

## 5. Spend-based rate limiting

Key by `user:date` so the window resets at midnight and old keys expire themselves — no
cron, no cleanup job.

`INCRBYFLOAT` is atomic, so concurrent requests can't lose each other's spend the way a
read-modify-write would. The **check** is still racy (two requests can both pass before
either records), but the accounting is never wrong, which is what matters for the next
request.

Return **429**, not 403 — it's a rate limit and it resets.

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
