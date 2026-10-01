# AI Learning — a backend engineer's path into production AI

Small projects, each teaching one skill you need to run an LLM in production rather than
demo one. Assembled into a capstone at the end.

Plain JavaScript (ESM), Node 20+, Docker for infra. **No agent frameworks** — the point is
to build the loop yourself, because the mechanism is the lesson.

## The ladder

| #   | Project                                             | Teaches                                                                   | Status |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 01  | [`streaming-gateway`](projects/01-streaming-gateway) | SSE, cancellation, timeouts, retry semantics under streaming              | ✅ built |
| 02  | [`tool-calling`](projects/02-tool-calling)           | Structured outputs, schema validation, tool loops, iteration caps         | ✅ built |
| 03  | [`observability`](projects/03-observability)         | OTel traces for LLM calls, token/cost accounting, redaction               | ✅ built |
| 04  | [`semantic-cache`](projects/04-semantic-cache)       | Redis vector cache, spend-based rate limiting, model routing              | ✅ built |
| 05  | [`retrieval`](projects/05-retrieval)                 | RAG over your own PDFs — chunking, hybrid search, grounded answers        | ✅ built |
| 06  | `evals`                                              | Golden datasets, LLM-as-judge, CI quality gate                            | planned |
| 07  | `mcp-server`                                         | Model Context Protocol server, real tools, wired into a client            | planned |
| 08  | `durable-agent`                                      | BullMQ durability, checkpointing, human-in-the-loop, prompt injection     | planned |
| 09  | `capstone`                                           | Assemble 01–08 into one deployable service                                | planned |

## What the built projects demonstrate

**01 — Streaming gateway.** An SSE gateway in front of an LLM, with zero dependencies:
`node:http` and `fetch` only. Client disconnect aborts the upstream call so you stop
paying for tokens nobody reads. A connect timeout plus a per-token idle watchdog, because
a hung stream doesn't error — it just goes quiet, and a total timeout can't tell that from
a long healthy answer. Retries happen **only before the first byte**; after that the 200
is committed and a retry would splice two different answers together.

**02 — Tool calling.** The model never executes anything: it emits a request, and your
code validates it, decides whether to allow it, and runs it. Zod validation before
execution, authorization enforced inside the tool against the session's real user, vague
denials so relayed tool output can't leak an order's existence, and a human-approval gate
on destructive actions.

> Measured while building: `gpt-oss-120b` refused to call a tool with `orderId: "99"`,
> while `gpt-oss-20b` passed it straight through and only Zod stopped it. Same code, same
> prompt. **The validator is the boundary — you can't rely on the model being clever.**

**03 — Observability.** Normal APM answers *"did it work?"*. An LLM call can return 200,
fast and fluent and completely fabricated, with every dashboard green. So this records
what was said, what it cost per user and per feature, and — critically — **which tools
were actually invoked**.

> That last one catches a failure nothing else can. Asked *"how many days until my order
> arrives?"*, the model answered confidently **without ever calling the clock tool**. It
> has no clock. It guessed, and was wrong by two days. HTTP 200, no error, plausible
> prose. The only signal was an empty entry in `tools_used`.

**04 — Semantic cache.** Cache answers by *meaning* rather than exact wording, using
local embeddings and Redis — plus spend-based rate limiting and cheap-model-first routing.

> The finding that shaped the whole project: questions that **mean the same thing** score
> **0.51–0.94** similarity, while questions needing **completely different answers** score
> **0.62–0.96**. The ranges overlap, and the most dangerous pair — two different order IDs
> — scores **highest of all at 0.962**.
>
> **No threshold separates them.** So the cache is guarded by rules that overrule the
> score: exact identifier matching, never caching tool-derived answers (reusing project
> 03's tool audit), and per-user namespacing. The honest result is a **12% hit rate** —
> low, and trustworthy.

**05 — Retrieval (RAG).** Ask questions of your own PDFs and get answers grounded in
cited passages — or an explicit refusal. PDF extraction, chunking with overlap at natural
boundaries, hybrid search (pgvector + Postgres full-text, fused by Reciprocal Rank
Fusion), and four layered grounding mechanisms.

> **"Only answer from the context" in the prompt is a request, not a control.** So the
> locks are: a **retrieval gate** that refuses before the model is ever called (measured
> at **$0.0000000** — no model call happens), a structured `sufficient_context` field,
> **citation ids validated in code** against what was actually supplied, and a check that
> the answer's numbers appear in the cited text. Two of those four the model cannot defeat.
>
> The case that justifies layering them: asked about *"annual leave for grade 12"* — a
> grade the handbook doesn't cover — the similarity gate **passed**, because the question
> is textually near-identical to the grade 5/7/9 lines. The structured-output lock caught
> it: *"the passages only specify grades 5, 7, and 9"*.
>
> Also measured: `plainto_tsquery` ANDs every term, so the keyword half of hybrid search
> returned **zero rows on every natural-language question** — invisible, because the
> vector half kept returning plausible results.

## Per-project files

Every project folder carries its own learning material:

| File          | Committed?          | Purpose                                                                      |
| ------------- | ------------------- | ---------------------------------------------------------------------------- |
| `NOTES.md`    | yes                 | The theory. Part A explains it with no jargon; Part B uses the real terms.   |
| `TESTING.md`  | yes                 | Every feature, the command to exercise it, and the output you should see     |
| `PRACTICE.md` | **no** (gitignored) | Self-test questions and answer keys, kept local for personal recall practice |

## Setup

```bash
npm install
cp .env.example .env    # then fill in your keys
```

Free API keys:

- Groq — https://console.groq.com/keys
- Google AI Studio — https://aistudio.google.com/apikey

## Running a project

```bash
npm run dev --workspace=01-streaming-gateway    # then http://localhost:8787
npm run dev --workspace=02-tool-calling         # then http://localhost:8788
npm run dev --workspace=03-observability        # then http://localhost:8789
npm run dev --workspace=04-semantic-cache       # then http://localhost:8790  (needs Redis)
npm run dev --workspace=05-retrieval            # then http://localhost:8791  (needs Postgres)
```

Each project's `TESTING.md` walks through every feature — browser first, command line
after.

> **Windows:** the commands in `TESTING.md` assume **Git Bash**. In PowerShell `curl` is
> an alias for `Invoke-WebRequest` — use `curl.exe` there instead.

## Constraints this repo is built around

Some choices here look unusual until you know the budget. They're deliberate:

- **8 GB RAM laptop, no GPU.** Inference runs on free hosted tiers, not locally.
  Embeddings (small models) run locally because they're cheap.
- **Everything free.** Free API tiers plus self-hosted Docker infra. No paid services.
- **WSL2 capped** at 4 GB via `%USERPROFILE%\.wslconfig` so Docker can't starve Windows.
- **Never all containers at once.** Bring up only what the current project needs.

This is why project 03 uses Jaeger (one container, in-memory, 512 MB cap) rather than
Langfuse, which now wants Postgres + ClickHouse + Redis + object storage.

> **Note on cost figures.** Providers return token counts, not money. The dollar amounts
> come from a hardcoded, **unverified** price table, and the free tier bills nothing.
> The mechanism transfers; the constants don't. Don't quote a number from this repo as a
> fact about anyone's pricing.
