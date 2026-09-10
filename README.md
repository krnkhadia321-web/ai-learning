# AI Learning — backend engineer path

A monorepo of small projects, each teaching one production-AI skill, assembled into a
capstone at the end. Plain JavaScript (ESM), Node 20+, Docker for infra.

## Constraints this repo is built around

- **8 GB RAM laptop, no GPU.** Inference runs on free hosted tiers, not locally.
  Embeddings (small models) run locally because they're cheap.
- **Everything free.** Free API tiers + self-hosted Docker infra. No paid services.
- **WSL2 capped** at 4 GB via `%USERPROFILE%\.wslconfig` so Docker can't starve Windows.
- **Never all containers at once.** Bring up only what the current project needs.

## The ladder

| #   | Project             | Teaches                                                                   |
| --- | ------------------- | ------------------------------------------------------------------------- |
| 01  | `streaming-gateway` | SSE, cancellation, timeouts, retry semantics under streaming              |
| 02  | `tool-calling-loop` | Structured outputs, schema validation, tool loops, iteration caps         |
| 03  | `observability`     | OTel traces for LLM calls, token/cost accounting                          |
| 04  | `semantic-cache`    | Redis vector cache, spend-based rate limiting, model routing              |
| 05  | `retrieval`         | pgvector, chunking, hybrid BM25+vector search, local reranking            |
| 06  | `evals`             | Golden datasets, LLM-as-judge, CI quality gate                            |
| 07  | `mcp-server`        | Model Context Protocol server, real tools, wired into a client            |
| 08  | `durable-agent`     | BullMQ job durability, checkpointing, human-in-the-loop, prompt injection |
| 09  | `capstone`          | Assemble 01–08 into one deployable service                                |

## Per-project files

Every project folder carries its own learning material:

| File          | Committed?          | Purpose                                                                       |
| ------------- | ------------------- | ----------------------------------------------------------------------------- |
| `NOTES.md`    | yes                 | The theory. Part A explains it with no jargon; Part B uses the real terms.    |
| `TESTING.md`  | yes                 | Every feature, the command to exercise it, and the output you should see      |
| `PRACTICE.md` | **no** (gitignored) | Self-test questions and answer keys, kept local for personal recall practice  |

> **Windows shell note:** the commands in `TESTING.md` assume **Git Bash**. In PowerShell
> `curl` is an alias for `Invoke-WebRequest` — use `curl.exe` there instead.

## Setup

```bash
npm install
cp .env.example .env    # then fill in your keys
```

Free keys:

- Groq — https://console.groq.com/keys
- Google AI Studio — https://aistudio.google.com/apikey

## Running a project

```bash
npm run dev --workspace=01-streaming-gateway
```
