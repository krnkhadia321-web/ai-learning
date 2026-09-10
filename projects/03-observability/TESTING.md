# Project 03 — Testing guide

Every feature built in this project, with the command to exercise it and what you should
see.

## ⚠️ Windows: use Git Bash, not PowerShell

**Run every command in this file in Git Bash.** In VS Code: the `+` dropdown at the top
right of the terminal panel → **Git Bash**.

In PowerShell, `curl` is an **alias for `Invoke-WebRequest`** — a completely different
program. You get confusing errors like:

```
Invoke-WebRequest : Missing an argument for parameter 'SessionVariable'
```

That is PowerShell reading curl's `-s` flag as its own `-SessionVariable`.

If you must use PowerShell, translate as you go:

| Git Bash | PowerShell |
|---|---|
| `curl` | **`curl.exe`** — the `.exe` bypasses the alias |
| `-o /dev/null` | `-o NUL` |
| `VAR=x node ...` | `$env:VAR='x'; node ...` |
| `$GROQ_API_KEY` | `$env:GROQ_API_KEY` |
| `A && B` | `A; if ($?) { B }` |
| `grep foo` | `Select-String foo` |

Two Part C checks in PowerShell, since you'll likely hit these first:

```powershell
docker ps --filter name=ai-learning-jaeger        # same in both shells
(Invoke-WebRequest http://localhost:16686 -UseBasicParsing).StatusCode   # expect 200
```

---

**Three parts.** Part A is the browser walkthrough and Part B the command-line checks —
both work with no Docker at all, because the cost ledger is always on. Part C adds
Jaeger for the trace waterfall.

---

# Setup

```bash
npm run dev --workspace=03-observability
```

Expected startup output:

```
▸ tracing disabled (set OTEL_ENABLED=true after `npm run jaeger:up`)
▸ observability server on http://localhost:8789
  content capture: redacted  (GENAI_CAPTURE=full|redacted|none)
```

---

# PART A — Browser walkthrough (no Docker)

Open **http://localhost:8789**

The page has: a **question box**, a **user dropdown**, **four preset buttons**, a line
showing the **trace ID**, a **"This request"** panel of cards, and a **Ledger** section at
the bottom with **Refresh** and **Reset** buttons.

---

## A1. Cost per request — and why it isn't proportional

**Step 1.** Click preset **"Single call — compare the cost"** (*What is the capital of
France?*).

Read the **This request** cards:

```
cost            $0.000039
tokens          392
model calls     1
wall time       520ms
tools used      ⚠ none
```

**Step 2.** Click preset **"Multi-step — 3 model calls, 2 tools"**.

```
cost            $0.000169
tokens          1656
model calls     3
wall time       2900ms
tools used      get_order_status, get_current_time
```

**Compare the two.** 3 model calls, but roughly **4× the cost** — not 3×.

**Why:** the model has no memory between calls, so each round resends the entire
conversation so far. Round 3 carries rounds 1 and 2 with it. **Cost grows faster than
round count.**

**Proves:** cost is a per-request property that has to be measured, not estimated from
traffic volume.

---

## A2. The guessing detector ⭐

This is the headline feature — catching a **right answer produced the wrong way**.

**Step 1.** Click preset **"Date question — did it call the clock tool?"**

Look at the **tools used** card. With a strong model you should see:

```
tools used      get_order_status, get_current_time
```

The clock was genuinely consulted. Good.

**Step 2 — now reproduce the bug, deterministically.**

You *could* hope a weaker model misbehaves, but that's a coin flip — capable models
usually do call the clock, and you just get another healthy trace.

Instead, **take the clock away.** Restart with:

```bash
cd projects/03-observability
DISABLE_TOOLS=get_current_time node --env-file=../../.env src/server.js
```

Startup confirms it:

```
⚠  DISABLE_TOOLS is set — hiding from the model: get_current_time
   The model now has 3 of 4 tools.
```

Reload the page, click the same preset.

**Actual observed result** (10 Sep 2026, order ETA 9 Sep 2026):

```
final answer    "Your order A-1001 is expected to arrive in 1 day."
tools used      get_order_status
```

**That answer is wrong.** The order was due *yesterday* — it's already late. The model
had no clock, invented today's date, got it wrong by two days, and stated the result as
fact. HTTP 200, no error, no warning, confident prose.

**Compare the two runs side by side:**

| | Clock available | Clock removed |
|---|---|---|
| Answer | *"ETA 9 Sep, today is 10 Sep, should have already arrived"* ✅ | *"expected to arrive in 1 day"* ❌ |
| `tools used` | `get_order_status, get_current_time` | `get_order_status` |
| HTTP status | 200 | 200 |
| Error raised | none | none |

> **This is the whole point of the project.** Same model, same question, same code. The
> only signal distinguishing a correct answer from a wrong one is **the tool list**.

**Why this is more than a lab trick.** A tool vanishing from the model's options is a
real production failure: it gets rate-limited, throws on registration, or someone
mistypes a name in a config. The tool silently disappears — and the model **papers over
the gap with a guess** instead of failing loudly. `DISABLE_TOOLS` simulates exactly that.

**Remember to restart without `DISABLE_TOOLS`** before running the other tests.

---

## A3. The ledger — attribution

Ask **four or five different questions**, switching the **user dropdown** between `u_1`
and `u_2` as you go. Then scroll to the **Ledger** section and click **Refresh**.

**Expect** totals plus three breakdown tables:

```
total spend  $0.000212     model calls 4     output % of cost  62%

By model      openai/gpt-oss-20b   4 calls   1893 in   231 out   $0.000212
By user       u_1                  3 calls   ...
              u_2                  1 call    ...
By operation  chat                 4 calls   ...
```

**Proves:** cost attributed along three dimensions. This is the difference between
*"we spent $400 last month"* (trivia) and *"the support agent costs $0.02 per
conversation and u_1 ran most of them"* (a decision).

**Note the "output % of cost" card.** Output tokens are far fewer than input tokens but
usually the majority of the spend — output rates are several times input rates.

---

## A4. The trace ID — and the all-zeros diagnostic

Look at the line just above the timeline. With `OTEL_ENABLED=false` it reads:

> *tracing disabled — trace ID is all zeros. Start Jaeger (`npm run jaeger:up`), set
> `OTEL_ENABLED=true` in .env, restart.*

**All zeros is meaningful**, not a bug in the page. It means the OTel SDK never started,
so every span is a no-op. **This is the fastest way to diagnose "why is my monitoring
empty?"** — check the trace ID before anything else.

You'll see a real ID, and a clickable Jaeger link, in Part C.

---

## A5. Is the cheap model actually cheaper? ⭐

The experiment that only a ledger can settle.

1. Click **Reset ledger**.
2. With `GROQ_TOOL_MODEL=openai/gpt-oss-120b`, run the **multi-step** preset **three
   times**. Note **total spend** and **model calls**.
3. Restart with `GROQ_TOOL_MODEL=openai/gpt-oss-20b`. Reset the ledger again.
4. Run the same preset three times. Compare.

**What to look for:** the cheap model has a lower rate *per token*, but often needs **more
iterations** to reach the same answer — and every extra iteration resends the whole
conversation.

**The total can go up.** Compare **cost per completed question**, not cost per call.

**Proves:** you cannot reason your way to this answer. You have to measure it.

---

## Browser checklist

| # | Do | Pass if |
|---|---|---|
| A1 | run both cost presets | multi-step ≈ 4× the single call, not 3× |
| A2 | date preset normally, then with `DISABLE_TOOLS=get_current_time` | second run answers confidently and **wrongly**, with no `get_current_time` in the tool list |
| A3 | 5 questions across both users, Refresh | three breakdown tables populated |
| A4 | look above the timeline | says "tracing disabled", ID is all zeros |
| A5 | 3 runs each model, compare totals | you have a measured answer, not a guess |

---
---

# PART B — Command line (no Docker)

For the health endpoint, redaction, and the health-check exclusion — none of which the
browser exposes.

Helper for the SSE tests:

```bash
show() { grep '^data:' | sed 's/^data: //' | grep -v '"thinking"'; }
```

**Paste that into your terminal before running anything in this part.**

> Shell functions live only in the terminal that defined them. Open a new tab, or
> restart VS Code, and you will get `bash: show: command not found` — just paste it
> again. To make it permanent for future terminals, append the same line to
> `~/.bashrc`.

All it does is strip the SSE wrapper: keep the `data:` lines, drop the `data: ` prefix,
and hide the noisy `thinking` events so you see the tool calls and the final answer.

---

## 1. Health check

```bash
curl -s http://localhost:8789/healthz
```

**Expect:** `{"ok":true,"capture":"redacted","tracing":false}`

---

## 2. The trace ID header (Problem 5)

```bash
curl -si -X POST http://localhost:8789/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"where is order A-1001"}' | grep -i x-trace-id
```

**Expect right now:** `X-Trace-Id: 00000000000000000000000000000000`

**All zeros is meaningful** — it means the OTel SDK never started, so every span is a
no-op. This is the fastest way to diagnose "why is my monitoring empty?". You'll see a
real ID in Part C.

---

## 3. `tools_used` — catching right-answer-wrong-process (Problem 2)

```bash
curl -sN -X POST http://localhost:8789/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Where is my order A-1001, and how many days until it arrives?"}' | show
```

**Expect** the answer event to carry the list of tools actually invoked:

```json
{"type":"answer","text":"Your order A-1001 is shipped ...","iterations":3,
 "totalTokens":1656,"costUsd":0.000169425,
 "toolsUsed":["get_order_status","get_current_time"]}
```

**Proves:** the clock was genuinely consulted.

**Now the failing case.** Restart with the weaker model, which tends to guess:

```bash
cd projects/03-observability
GROQ_TOOL_MODEL=openai/gpt-oss-20b node --env-file=../../.env src/server.js
```

Ask the same question. If `toolsUsed` comes back as `["get_order_status"]` — **no
`get_current_time`** — while the answer still confidently states a number of days, you've
reproduced the bug from project 02: a correct-looking answer produced by guessing.

> This is the whole point of the project. The answer looks identical either way. Only
> `toolsUsed` distinguishes them.

---

## 4. Cost accounting (Problem 3)

Ask a few different questions first, then:

```bash
curl -s http://localhost:8789/v1/usage
```

**Expect** a breakdown along three dimensions:

```json
{
  "total": { "calls": 4, "inputTokens": 1893, "outputTokens": 231, "usd": 0.000212 },
  "byModel":     { "openai/gpt-oss-20b": { "calls": 4, "usd": 0.000212 } },
  "byUser":      { "u_1": { "calls": 4, "usd": 0.000212 } },
  "byOperation": { "chat": { "calls": 4, "usd": 0.000212 } },
  "recent": [ { "model": "...", "inputTokens": 348, "outputTokens": 44,
                "reasoningTokens": 26, "usd": 0.0000393, "durationMs": 482 } ]
}
```

**Proves:** cost computed per call, attributed to a user and an operation, with
**`reasoningTokens` counted separately** — billed at the output rate, never visible in
the response.

Compare two questions to see the spread:

```bash
# 1 model call
curl -sN -X POST http://localhost:8789/v1/agent -H 'Content-Type: application/json' \
  -d '{"question":"What is the capital of France?"}' | show | grep costUsd

# 3 model calls
curl -sN -X POST http://localhost:8789/v1/agent -H 'Content-Type: application/json' \
  -d '{"question":"Where is my order A-1001, and how many days until it arrives?"}' | show | grep costUsd
```

The second should be roughly **4× more expensive**, not 3× — because each round resends
the whole conversation.

Reset between experiments:

```bash
curl -s -X POST http://localhost:8789/v1/usage/reset
```

---

## 5. Redaction (Problem 4)

Unit check, no server needed:

```bash
cd "path/to/AI learning"
node --input-type=module -e "
const { redact } = await import('./projects/03-observability/src/genai.js');
console.log(redact('email anshul@gmail.com, card 4111 1111 1111 1111, phone 98765 43210, PAN ABCDE1234F'));
"
```

**Expect:** `email [email], card [card], phone [phone], PAN [pan]`

⚠️ **Check the card specifically.** If it says `[phone]` the pattern ordering has
regressed — a card is also a long run of digits, so the card rule must run *first*.

**Now see the limitation.** Add something no pattern knows about:

```bash
node --input-type=module -e "
const { redact } = await import('./projects/03-observability/src/genai.js');
console.log(redact('My mother\'s maiden name is Kaur and I live opposite the temple on Nehru Road'));
"
```

**Expect:** the sentence comes back **completely unchanged.** That's the honest limit of
regex redaction — it cannot bleep what it does not recognise. For regulated data the
answer is `GENAI_CAPTURE=none`.

**Test the capture modes** by restarting with each:

```bash
GENAI_CAPTURE=none node --env-file=../../.env src/server.js
```

Then `curl -s http://localhost:8789/healthz` should report `"capture":"none"`. In Part B
you'll be able to see the difference in the actual span content.

---

## 6. Health-check exclusion (Problem 6)

```bash
for i in 1 2 3 4 5; do curl -s http://localhost:8789/healthz > /dev/null; done
```

**Expect:** nothing new in the server terminal, and in Part B, **no new traces in Jaeger**.

**Proves:** `/healthz` returns at the top of the handler, before `startActiveSpan` is
ever reached, so no span is created at all. Compare with `/v1/agent`, which logs and
traces every time.

---

# PART C — With Jaeger (needs Docker Desktop)

## Setup

**1. Start Docker Desktop** and wait for it to be ready. Verify:

```bash
docker info > /dev/null 2>&1 && echo "docker ready" || echo "not running"
```

**2. Start Jaeger:**

```bash
npm run jaeger:up --workspace=03-observability
```

First run pulls the image (~100 MB). Verify it's up:

```bash
docker ps --filter name=ai-learning-jaeger --format "{{.Names}}  {{.Status}}"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:16686
```

**Expect:** the container listed as `Up`, and `200` from the UI.

**3. Turn tracing on** — set in `.env`:

```
OTEL_ENABLED=true
```

**4. Restart the server.** Expected startup output now:

```
▸ tracing → http://localhost:4318  (UI: http://localhost:16686)
▸ observability server on http://localhost:8789
```

---

## 7. A real trace ID

**In the browser** (easiest): reload **http://localhost:8789** and ask anything.

The line above the timeline has changed. Instead of *"tracing disabled"* it now reads:

> trace `4bf92f3577b34da6a3ce929d0e0e4736` — **open in Jaeger →**

**Click that link.** It opens the exact trace for the request you just ran.

**Proves:** the SDK started, spans are real, and the receipt-number affordance from
Problem 5 works end to end — one click from "this request misbehaved" to its full record.

**From the command line**, if you prefer:

```bash
curl -si -X POST http://localhost:8789/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"where is order A-1001"}' | grep -i x-trace-id
```

**Expect:** a real 32-character hex ID — **not** all zeros. Open it at
`http://localhost:16686/trace/<id>`.

---

## 8. The waterfall — the payoff

Ask the multi-step question, then open the trace.

**Expect this shape:**

```
POST /v1/agent                              ← SpanKind.SERVER, the whole request
└── invoke_agent support-agent              ← the agent run
    ├── chat openai/gpt-oss-120b            ← iteration 1 (SpanKind.CLIENT)
    ├── execute_tool get_order_status       ← your code, fast and free
    ├── chat openai/gpt-oss-120b            ← iteration 2
    ├── execute_tool get_current_time
    └── chat openai/gpt-oss-120b            ← iteration 3, final answer
```

**Things to check in the UI:**

| Look for | On which span | What it tells you |
|---|---|---|
| `gen_ai.usage.input_tokens` / `output_tokens` | each `chat` | where the tokens went |
| `gen_ai.usage.reasoning_tokens` | each `chat` | invisible billed output |
| `gen_ai.usage.cost_usd` | each `chat` | per-call cost |
| `gen_ai.agent.tools_used` | the root `invoke_agent` | what was actually consulted |
| `gen_ai.tool.outcome` | each `execute_tool` | `ok` / `validation_failed` / … |
| `gen_ai.response.finish_reasons` | each `chat` | `length` here means truncated |
| span durations | the bar widths | model calls dominate; tools are near-instant |

**Proves:** nesting via async context, `SERVER` vs `CLIENT` span kinds, and the GenAI
semantic-convention attributes.

---

## 9. Content capture, seen for real

**Where to look in Jaeger** — this is fiddly the first time:

1. Open the trace (click **open in Jaeger →** on the page, or paste the ID).
2. In the waterfall, **click the row `invoke_agent support-agent`** to expand it.
3. Expand the **`Tags`** section inside it.
4. Find **`gen_ai.input.question`** — the user's raw question, and
   **`gen_ai.output.answer`** — the final reply.

> Use the `invoke_agent` span, **not** a `chat` span. The `chat` spans carry
> `gen_ai.input.messages`, which is the *entire* conversation as one long JSON blob —
> system prompt, tool results and all — so the redaction is buried in it.
> `gen_ai.input.question` is short and readable.

Ask the PII question with each mode and compare that one tag:

```bash
# redacted (default)
curl -sN -X POST http://localhost:8789/v1/agent -H 'Content-Type: application/json' \
  -d '{"question":"My email is test@example.com and my card is 4111 1111 1111 1111 — where is order A-1002?"}' > /dev/null
```

**Expect in Jaeger:** `My email is [email] and my card is [card] — where is order A-1002?`

Restart with `GENAI_CAPTURE=full` and repeat → the raw values appear.
Restart with `GENAI_CAPTURE=none` → the attribute is **absent entirely**, while token
counts and timings remain.

---

## 10. Tool failure outcomes

```bash
curl -sN -X POST http://localhost:8789/v1/agent -H 'Content-Type: application/json' \
  -d '{"question":"Please cancel order A-1002"}' | show
```

**Expect** in Jaeger: an `execute_tool cancel_order` span with
`gen_ai.tool.outcome = approval_required`, and the root span carrying
`gen_ai.agent.halted_reason = awaiting_human_approval`.

Run the weak-model bad-argument case from project 02 and look for
`gen_ai.tool.outcome = validation_failed` with `gen_ai.tool.validation_errors` attached.

---

## 11. Losing telemetry — reproduce it deliberately

Worth doing once so you recognise it later.

**Kill the server hard** (close the terminal window, don't Ctrl+C) immediately after a
request. The last trace will often be missing from Jaeger — spans are batched and the
un-flushed batch dies with the process. That's what `sdk.shutdown()` on SIGTERM/SIGINT
prevents.

---

## Shut down

```bash
npm run jaeger:down --workspace=03-observability
```

Traces are in-memory only, so they're gone. That's intentional — nothing to clean up.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Trace ID is all zeros | `OTEL_ENABLED` isn't `true`, or the server wasn't restarted after changing it |
| `failed to connect to the docker API` | Docker Desktop isn't started |
| Jaeger UI loads but shows no traces | check the service dropdown says `ai-learning-03`; confirm `OTEL_ENABLED=true` in the startup log |
| Last trace before a restart is missing | expected if the process was killed hard — see test 11 |
| Laptop crawling with Jaeger up | check `%USERPROFILE%\.wslconfig` caps WSL2 memory; Jaeger is also capped at 512 MB in `docker-compose.yml` |
| `/healthz` appearing in Jaeger | the exclusion broke — it must return before `startActiveSpan` |
