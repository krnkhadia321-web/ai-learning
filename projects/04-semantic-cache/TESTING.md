# Project 04 — Testing guide

Every feature built in this project, with what to click and what you should see.

## ⚠️ Windows: use Git Bash, not PowerShell

**Run every command in this file in Git Bash.** In VS Code: the `+` dropdown at the top
right of the terminal panel → **Git Bash**.

In PowerShell, `curl` is an **alias for `Invoke-WebRequest`** — a completely different
program. You get errors like `Missing an argument for parameter 'SessionVariable'`.

| Git Bash | PowerShell |
|---|---|
| `curl` | **`curl.exe`** — the `.exe` bypasses the alias |
| `VAR=x node ...` | `$env:VAR='x'; node ...` |
| `A && B` | `A; if ($?) { B }` |

---

# Setup

**1. Start Redis** (~15 MB — you'll keep it for project 05 too):

```bash
npm run redis:up --workspace=04-semantic-cache
docker ps --filter name=ai-learning-redis --format "{{.Names}} {{.Status}}"
```

**2. Start the server:**

```bash
npm run dev --workspace=04-semantic-cache
```

Expected startup — note it takes ~10 seconds the first time while the embedding model
downloads (~25 MB, cached on disk afterwards):

```
▸ semantic cache server on http://localhost:8790
▸ redis connected: redis://localhost:6379
▸ embedding model ready: Xenova/all-MiniLM-L6-v2 (384 dims)
▸ routing break-even: escalation must stay under 50%
```

> If Redis isn't running you'll get a clear warning and the server still works — it just
> answers everything from the model with no caching or budgets. That's deliberate:
> degrading loudly beats failing silently.

---
---

# PART A — Browser walkthrough

Open **http://localhost:8790**. Two tabs: **Cache** and **Model routing**.

Work through the presets in order — several only make sense as pairs.

---

## A1. A genuine cache hit

1. Click preset **1** — *"What is the capital of France?"*
2. Click preset **2** — *"Which city is the capital of France?"*

**Expect on the first:** a blue card, `model — $0.000047 · 439 tokens · ~600ms`.

**Expect on the second:** a green card:

```
cache hit — $0.000000, no model call
similarity 0.9378
matched:   "What is the capital of France?"
latency    24ms  (vs ~600ms for a model call)
```

**Proves:** different wording, same meaning, zero cost, ~25× faster.

> **Note the `matched:` line.** Every hit shows what it matched against. A cache you
> can't audit is a cache you can't trust — and that line is what makes a *wrong* hit
> visible instead of invisible.

---

## A2. ⭐ The identifier guard — the heart of the project

1. Click preset **3** — *"How many days of annual leave does a grade 5 employee get?"*
2. Click preset **4** — *"...grade 7 employee get?"*

One digit different. Different correct answer.

**Expect on the second** — a blue answer card **and** a red guard card:

```
⚠ identifier guard blocked a match

would have matched: "How many days of annual leave does a grade 5 employee get?"
similarity:         0.933   (above the threshold!)
its identifiers:    ["5"]

Similarity was 0.933 — above the 0.85 threshold — but the identifiers differ,
so this would have been a WRONG answer.
```

**Proves:** similarity alone would have served the grade-5 answer to a grade-7 question,
confidently and for free. The score was **above** the threshold; the guard overruled it.

> **This is why a threshold isn't enough.** 0.933 is a *higher* score than the genuine
> hit in A1 (0.938 — barely different), yet one is right and one is dangerous. No cut-off
> can tell them apart. The identifier check can, and the score gets no vote.

Scroll to **What's in the cache** and note both entries stored with their identifiers:
`["5"]` and `["7"]`.

---

## A3. Tool-derived answers are never cached

1. Click preset **5** — *"Where is my order A-1001?"*
2. **Click it again.**

**Expect both times** — a model call, and an amber card:

```
not cached — tool-derived answer
Used get_order_status — live data, so caching it would serve a stale
or another user's fact.
```

**You paid twice for the identical question.** That is correct, and it's the trade:
caching it would mean serving a stale order status — or, on a false hit, another
customer's.

**Proves:** `toolsUsed.length > 0` is the cacheability test. This is project 03's tool
audit doing a second job.

> It also quietly solves a case no threshold could: *"Can I cancel my order?"* (policy,
> no tools, cacheable) versus *"Did I cancel my order?"* (needs a tool, never cached).
> Those embed at **0.839** and would otherwise collide.

---

## A4. The honest cost of a safe threshold

1. Click preset **6** — *"What is your return policy?"*
2. Click preset **7** — *"How do I return an item?"*

**Expect:** the second one **misses**. Two model calls, two cache entries.

Those questions mean the same thing — but they score **0.508**, well under the 0.85
threshold.

**Proves:** a safely-tuned cache misses genuine paraphrases. That's not a bug, it's the
price of A2 working.

Check the **hit rate** stat. After all seven presets it should read around **12%**.

> When you see *"semantic caching cut our costs 40%"*, the options are: a genuinely
> repetitive workload, a loose threshold serving wrong answers nobody noticed, or nobody
> measured. **A low hit rate you can trust beats a high one you can't.**

---

## A5. ⭐ Prove there is no good threshold

The experiment that makes the whole project land. Stop the server and restart it with a
loose threshold:

```bash
cd projects/04-semantic-cache
CACHE_THRESHOLD=0.5 node --env-file=../../.env src/server.js
```

Reload the page, click **Clear cache**, then re-run **A4** (presets 6 and 7).

**Now it hits** — 0.508 clears a 0.5 threshold. You've "fixed" the miss.

Now re-run **A2** (presets 3 and 4) and check what else you let in. Then try:

```
"How do I get a refund?"     then    "How long do refunds take?"     (0.623)
```

Different questions, different answers, and at 0.5 they now match each other.

**Proves:** the setting that fixes A4 breaks A2 and A5. **There is no value that gives
you both** — which is exactly why the guards exist and why they don't consult the score.

**Restart at the default afterwards.**

---

## A6. Spend limits

Restart with a deliberately tiny daily limit:

```bash
cd projects/04-semantic-cache
DAILY_LIMIT_USD=0.00005 node --env-file=../../.env src/server.js
```

Click **Reset budget**, then ask **three different questions** in a row (vary the wording
so they don't hit the cache).

**Expect:**

```
call 1  →  answers normally
call 2  →  budget exceeded — HTTP 429
call 3  →  budget exceeded — HTTP 429
```

Watch the budget bar go green → amber → red.

**Now look at the numbers:**

```
spent $0.0000834   against a limit of $0.00005     ← 67% OVER
```

**Proves both the limit and its limitation.** Call 1 was allowed because the balance was
fine *beforehand* — and its cost was only knowable once it finished. You cannot
pre-authorise an LLM call the way a card payment reserves funds.

> That 67% is the stated tolerance, not a bug. With concurrent requests it would be
> larger. A limit with a known tolerance is more honest than one claiming to be exact.

**Restart at the default afterwards.**

---

## A7. Model routing and its break-even

Switch to the **Model routing** tab. Ask the same question three ways with the buttons.

**With a hard-but-answerable question** (the default about locking):

```
Force cheap     gpt-oss-20b     $0.0000967
Force strong    gpt-oss-120b    $0.0001988      ← 2.06× the cheap one
Routed          gpt-oss-20b     $0.0000964      ← cheap path, no escalation
```

**Now try questions the model lacks information for:**

| Type this | Expect |
|---|---|
| `What is the current price of Bitcoin right now?` | escalates, LOW → **HIGH** |
| `What will the weather be in Mumbai next Tuesday?` | escalates, LOW → **LOW** |
| `What did I have for breakfast?` | escalates, LOW → **LOW** |

**Look hard at the LOW → LOW rows.** You paid for **two** calls and got the same *"I
don't know"* twice.

**Proves the trap:** the senior expert doesn't know last Tuesday's weather either.
Escalating because the model *lacks information* is always wasted money — those questions
need a **tool**, not a bigger model. Only *reasoning* difficulty justifies paying twice,
and self-reported confidence can't tell the two apart.

The note under the result shows the break-even: **escalation must stay under 50%** for
routing to beat going straight to the strong model.

---

## Browser checklist

| # | Do | Pass if |
|---|---|---|
| A1 | presets 1 then 2 | green hit card, `$0.000000`, similarity 0.9378, shows what it matched |
| A2 | presets 3 then 4 | red guard card blocking a **0.933** match |
| A3 | preset 5 twice | amber "tool-derived" both times, paid twice |
| A4 | presets 6 then 7 | second one **misses** despite meaning the same |
| A5 | `CACHE_THRESHOLD=0.5`, redo A4 then A2 | A4 now hits, but A2/refund pairs now collide |
| A6 | `DAILY_LIMIT_USD=0.00005`, 3 questions | 200, 429, 429 — and spend **over** the limit |
| A7 | routing tab, hard vs unanswerable questions | 2× price gap; LOW→LOW escalations cost double for nothing |

---
---

# PART B — Command line

```bash
show() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
console.log(' source:',d.source,'| cost:',d.costUsd,'| tools:',JSON.stringify(d.toolsUsed||[]));
if(d.source==='cache')console.log(' ✅ HIT',d.similarity,'← matched:',JSON.stringify(d.matchedQuestion));
if(d.blockedMatch)console.log(' 🛑 BLOCKED',d.blockedMatch.score.toFixed(3),'←',JSON.stringify(d.blockedMatch.question));
if(d.cacheStored===false&&d.cacheSkipReason)console.log(' ⚠ not cached:',d.cacheSkipReason);
if(d.cacheStored)console.log(' 📥 cached');});"; }

ask() { curl -s -X POST http://localhost:8790/v1/ask -H 'Content-Type: application/json' \
  -d "{\"question\":\"$1\"}" | show; }
```

**Paste both into your terminal before running anything below.** Shell functions live
only in the terminal that defined them.

## 1. Health

```bash
curl -s http://localhost:8790/healthz
```

**Expect:** `"redis": true`, both model names, and the break-even block.

> If `redis` is `false`, the container isn't up. Note this endpoint checks `isReady`, not
> `isOpen` — an earlier version reported `true` while every command failed, because the
> client marks the socket open the moment it *starts* connecting.

## 2. The full sequence

```bash
ask "What is the capital of France?"
ask "Which city is the capital of France?"
ask "How many days of annual leave does a grade 5 employee get?"
ask "How many days of annual leave does a grade 7 employee get?"
ask "Where is my order A-1001?"
```

**Expect** — this exact shape:

```
 📥 cached
 ✅ HIT 0.9378 ← matched: "What is the capital of France?"
 📥 cached
 🛑 BLOCKED 0.933 ← "How many days of annual leave does a grade 5 employee get?"
 ⚠ not cached: tool-derived answer
```

## 3. Cache contents and stats

```bash
curl -s "http://localhost:8790/v1/cache?userId=u_1"
```

**Expect** stats like:

```json
{ "lookups": 8, "hits": 1, "misses": 7, "blockedByIdentifier": 1,
  "belowThreshold": 5, "notCacheable": 2, "stored": 5, "threshold": 0.85 }
```

Plus every entry with its extracted identifiers — `["5"]`, `["7"]`, `[]`.

## 4. Identifier extraction in isolation

```bash
cd "path/to/AI learning"
node --input-type=module -e "
const { extractIdentifiers } = await import('./projects/04-semantic-cache/src/cache.js');
for (const q of [
  'Where is my order A-1001?',
  'What are your top 5 products?',
  'Email me at test@example.com',
  'What is your return policy?',
]) console.log(JSON.stringify(extractIdentifiers(q)), '←', q);
"
```

**Expect:** `["a-1001"]`, `["5"]`, `["test@example.com"]`, `[]`.

The last one is the point: a question with no identifiers has nothing to guard, so the
similarity score decides on its own.

## 5. Per-user isolation

```bash
curl -s -X POST http://localhost:8790/v1/ask -H 'Content-Type: application/json' \
  -d '{"question":"What is the capital of France?","userId":"u_2"}' | show
```

**Expect:** a **model** call, not a cache hit — even though `u_1` asked the identical
question. Separate namespaces.

## 6. Inspect Redis directly

```bash
docker exec -it ai-learning-redis redis-cli
```

```
KEYS cache:*
SMEMBERS cache:ns:u_1
HGETALL cache:e:u_1:<paste-an-id>
TTL cache:e:u_1:<paste-an-id>
GET budget:u_1:2026-09-15
```

**Expect:** the embedding stored as a 384-number JSON array, a TTL counting down from
3600, and the budget as a plain float string.

`exit` to leave.

---

## Shut down

```bash
npm run redis:down --workspace=04-semantic-cache
```

No volume, so the cache disappears — intentional.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redis: false` in healthz | container not running — `npm run redis:up` |
| Server takes 10s to start | first run downloading the embedding model; cached after |
| Everything misses | check `threshold` in `/v1/cache` — and remember 0.85 is deliberately strict |
| A cache hit looks wrong | read the `matched:` line. That's what it's for. Then check whether the question had identifiers the guard could see |
| `ECONNREFUSED` spam on startup | Redis is down; the server degrades and says so |
| Routing never escalates | expected on knowledge questions — the cheap model reports HIGH. Try one needing live data |
