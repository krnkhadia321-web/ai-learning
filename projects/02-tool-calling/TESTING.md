# Project 02 — Testing guide

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

> **The `show()` helper in Part B is a Bash function** — it has no PowerShell equivalent.
> Part B really does need Git Bash.

---

## Setup

```bash
npm run dev --workspace=02-tool-calling
```

Expected: `▸ tool-calling server on http://localhost:8788`

If you see a ⚠ warning about no API key, stop and add one first.

---
---

# PART A — In the browser (start here)

Open **http://localhost:8788**

The page has **two tabs**. On the *Agent loop* tab: a **question box**, a **user
dropdown** (u_1 / u_2), an **Ask** button, and **six preset buttons** — one per scenario
below. Clicking a preset fills the box and runs it immediately.

Each step of the loop appears as its own coloured entry:

| Colour | Meaning |
|---|---|
| grey | iteration — asking the model |
| **green** | a tool ran successfully |
| **red** | a tool was rejected |
| **amber** | needs human approval, not executed |
| **blue** | the final answer |

---

## A1. Chained tool calls — the core loop

Click preset **"Two tools, chained — needs the order AND the current date"**.

**Watch the timeline build**, in this order:

```
iteration 1 — asking the model
tool ran → get_order_status      args: {"orderId":"A-1001"}   (green)
iteration 2 — asking the model
tool ran → get_current_time      args: {}                     (green)
iteration 3 — asking the model
final answer                                                  (blue)
```

Bottom line: `3 iteration(s) · 1644 tokens · 2900ms`

**Proves:** the loop ran three times. The tools are **chained** — it had to fetch the
order before it could reason about dates. It stopped when the model returned no more tool
requests.

> **Look at the token count.** It's large for one question because the entire conversation
> is resent on every iteration. That's why the iteration cap is a cost control.

---

## A2. Authorization ⭐

Order `A-2007` belongs to **u_2**.

**Step 1 — as the wrong user.** Leave the dropdown on **u_1** and click preset
**"Authorization — u_1 asking for u_2's order"**.

**Expect** — the tool runs (green), but returns nothing:

```
tool ran → get_order_status
  result: {"found":false,"reason":"No such order."}

final answer: "I'm sorry, there's no order with the ID A-2007."
```

Read that denial carefully. It does **not** say "that belongs to another customer" —
because the model repeats tool output to the user, and that phrasing would confirm the
order exists.

**Step 2 — as the right user.** Change the dropdown to **u_2**, click **Ask** again with
the same question.

**Expect:** `"found":true`, a standing desk, delivered.

**Proves:** same tool, same arguments, different caller, different result. The check is
real — not just broken. Step 2 is the control; without it Step 1 proves nothing.

---

## A3. The approval gate

Click preset **"Destructive action — stops for approval"**.

**Expect** an amber entry, and the run stops:

```
⚠ human approval required → cancel_order
  {"orderId":"A-1002"}
  NOT executed.
```

**Verify nothing actually happened** — type into the box:

```
What is the status of order A-1002?
```

**Expect:** still `processing`. Not `cancelled`.

**Proves:** the model *requested* a destructive action; your code refused to perform it
without a human. That's the difference between a request and a decision.

---

## A4. Argument validation — depends on the model ⭐

Click preset **"Bad arguments — result depends on the model"**.

**With `openai/gpt-oss-120b`** you'll likely see **one blue entry, no tool call at all**:

> *"I'm not able to find an order with the ID "99". Could you provide the full order ID
> (e.g. A-1234)?"*

The model was smart enough not to try.

**Now restart with the weaker model:**

```bash
cd projects/02-tool-calling
GROQ_TOOL_MODEL=openai/gpt-oss-20b node --env-file=../../.env src/server.js
```

Reload the page and click the same preset. **Now you get a red entry:**

```
tool rejected → get_order_status
  orderId: orderId must look like A-1001
```

followed by the model recovering and asking you for a proper ID.

**Proves:** the validator is the real boundary. The strong model *happened* to behave. The
weak one didn't, and only Zod stopped it from reaching your database. **You cannot rely on
the model being clever.**

---

## A5. The model choosing *not* to use a tool

Click preset **"No tool needed — model answers directly"**.

**Expect:** one grey iteration, then straight to blue. `1 iteration(s)`, no green entries.

**Proves:** `tool_choice: 'auto'` — the model decided a tool wasn't needed. It isn't
forced to call one.

---

## A6. Optional arguments from natural language

Click preset **"Structured arguments with an optional field"**.

**Expect** a green entry where the model filled in *both* parameters:

```
tool ran → search_products
  args: {"query":"desk","maxPriceInRupees":3000}
```

**Proves:** "under 3000 rupees" became a typed optional numeric field. Results are
filtered by price.

---

## A7. Structured extraction + the repair loop

Switch to the **Structured extraction** tab.

**Step 1.** Click **Extract** with the default angry email.

**Expect** a validated ticket:

```json
{
  "priority": "urgent",
  "category": "shipping",
  "summary": "Keyboard order A-1001 hasn't arrived after three weeks...",
  "sentiment": "angry",
  "orderId": "A-1001",
  "requiresHumanReview": true
}
```

with `1 attempt(s) — repair loop ran 0 time(s)` underneath, and the full **trace** below
that.

**Look inside the trace** for:

```json
"completion_tokens": 218,
"completion_tokens_details": { "reasoning_tokens": 157 }
```

157 of 218 output tokens were internal reasoning you never see — and paid for.

**Step 2 — prove it doesn't invent things.** Edit the email and **delete the order ID**
(`order A-1001`). Extract again.

**Expect:** `"orderId": null` — not a fabricated ID. That's the `.nullable()` in the schema
plus the explicit "never invent an order ID" instruction working together.

**Step 3 — force the repair loop to fire.** It normally succeeds first try. Open
`src/extract.js` and add a field to `TicketSchema` that the system prompt never mentions:

```js
escalationTeam: z.enum(['tier1', 'tier2', 'legal']),
```

Save (the server auto-restarts), reload, Extract again.

**Expect** `2 attempt(s)` or `3 attempt(s)`, and a trace containing a failed validation
before the successful one:

```json
{ "attempt": 1, "stage": "validate", "ok": false,
  "problems": "escalationTeam: Required" }
```

**Proves:** the model was handed its own broken output plus the exact error, and fixed it
on the next try. **Remove the extra field afterwards.**

---

## Browser checklist

| # | Click | Pass if |
|---|---|---|
| A1 | preset 1 | 3 iterations, two green tool entries in order |
| A2 | preset 2 as u_1, then as u_2 | denied then allowed; denial is vague |
| A3 | preset 4, then ask A-1002's status | amber, not executed, still `processing` |
| A4 | preset 5 on 120b, then on 20b | 120b declines; 20b gets a red validation error |
| A5 | preset 6 | 1 iteration, no tool entries |
| A6 | preset 3 | `maxPriceInRupees` populated |
| A7 | Extract tab | valid ticket; `null` orderId when removed; repair loop when forced |

---
---

# PART B — Command line

For the health endpoint and input validation, which the UI doesn't expose — plus curl
equivalents of the above when you want exact output.

Helper to strip the SSE wrapper and show only the interesting events:

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
curl -s http://localhost:8788/healthz
```

**Expect:** `{"ok":true,"hasGroqKey":true}`

If `hasGroqKey` is `false`, everything else will fail.

---

## 2. Chained tool calls — the core loop

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Where is my order A-1001, and how many days until it arrives?"}' | show
```

**Expect** two tool results, then an answer:

```json
{"type":"tool_result","name":"get_order_status","args":{"orderId":"A-1001"},
 "output":{"found":true,"status":"shipped","estimatedDelivery":"2026-09-09", ...}}
{"type":"tool_result","name":"get_current_time","args":{},"output":{"iso":"2026-09-..."}}
{"type":"answer","text":"Your order A-1001 has shipped ... that's N days.",
 "iterations":3,"totalTokens":1644}
```

**Proves:** the loop runs to completion; tools are chained (the model needed the order
*before* it could reason about dates); it stops when the model returns no tool calls.

> **Watch `totalTokens`.** It's large because the whole conversation is resent every
> iteration. That's why the iteration cap is a cost control.

---

## 3. Authorization — the security test

Order `A-2007` belongs to `u_2`. Ask as `u_1`:

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Show me order A-2007","userId":"u_1"}' | show
```

**Expect:**

```json
{"type":"tool_result","name":"get_order_status","output":{"found":false,"reason":"No such order."}}
{"type":"answer","text":"I'm sorry, there's no order with the ID A-2007 ..."}
```

**Proves:** the ownership check inside the tool blocked it — and the denial is
**deliberately vague**. It does not say "that belongs to another customer", because the
model repeats tool output to the user and that phrasing would leak the order's existence.

**Now confirm it isn't just broken:** ask as the rightful owner.

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Show me order A-2007","userId":"u_2"}' | show
```

**Expect:** `"found":true`, a standing desk, delivered. Same tool, same arguments,
different caller, different result.

---

## 4. Destructive action — the approval gate

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Please cancel order A-1002"}' | show
```

**Expect:**

```json
{"type":"approval_required","name":"cancel_order","args":{"orderId":"A-1002"}}
{"type":"answer","text":"This action needs your approval: cancel_order({\"orderId\":\"A-1002\"})",
 "awaitingApproval":true}
```

**Proves:** the loop halted; `cancel_order` was **not executed**. Verify by re-asking for
the order's status — it should still be `processing`, not `cancelled`:

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is the status of order A-1002?"}' | show
```

---

## 5. Argument validation — and why the result depends on the model

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Look up order 99"}' | show
```

**What happens depends on which model you're running**, and that's the point:

**With `openai/gpt-oss-120b`** — the model recognises `99` isn't a valid order ID and
never calls the tool:

```json
{"type":"answer","text":"I'm not able to find an order with the ID \"99\". Could you provide the full order ID (e.g. A-1234)?"}
```

**With `openai/gpt-oss-20b`** — it calls the tool anyway, and **Zod rejects it**:

```json
{"type":"tool_error","name":"get_order_status","error":"orderId: orderId must look like A-1001","args":{"orderId":"99"}}
{"type":"answer","text":"\"99\" isn't a valid order ID format. Order IDs look like \"A-1001\"."}
```

**To see the second one**, restart with the weaker model:

```bash
cd projects/02-tool-calling
GROQ_TOOL_MODEL=openai/gpt-oss-20b node --env-file=../../.env src/server.js
```

**Proves:** the validator is the real boundary. The strong model *happened* to behave;
the weak one didn't, and only Zod stopped it. You cannot rely on the model being clever.

---

## 6. No tool needed

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is the capital of France?"}' | show
```

**Expect:** `{"type":"answer","text":"The capital of France is Paris.","iterations":1}`

**Proves:** the model *chose* not to call a tool. `tool_choice: 'auto'` working — one
iteration, no tool spans.

---

## 7. Optional arguments

```bash
curl -sN -X POST http://localhost:8788/v1/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Find me desk accessories under 3000 rupees"}' | show
```

**Expect:** `search_products` called with **both** `query` and `maxPriceInRupees: 3000`,
and results filtered by price.

**Proves:** the model populated an optional parameter correctly from natural language.

---

## 8. Structured extraction + the repair loop

```bash
curl -s -X POST http://localhost:8788/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"email":"I ordered a keyboard three weeks ago (order A-1001) and it STILL has not arrived. I emailed twice with no reply. I want a full refund today or I am disputing the charge with my bank."}'
```

**Expect** a validated ticket:

```json
{
  "ticket": {
    "priority": "urgent",
    "category": "shipping",
    "summary": "Keyboard order A-1001 hasn't arrived after three weeks; customer demands refund...",
    "sentiment": "angry",
    "orderId": "A-1001",
    "requiresHumanReview": true
  },
  "attempts": 1,
  "trace": [ { "attempt": 1, "stage": "validate", "ok": true, "usage": {...} } ]
}
```

**Proves:** JSON mode + Zod validation produced a typed object. Every field is
constrained — `priority` is one of four values, `orderId` matches `A-\d{4}` or is null.

**Check the trace for reasoning tokens:**

```json
"usage": { "completion_tokens": 218, "completion_tokens_details": { "reasoning_tokens": 157 } }
```

157 of 218 output tokens were internal reasoning you never see — but paid for.

**To see the repair loop actually fire**, `attempts` must be > 1. It's model-dependent, so
force it by making the schema harder to satisfy — temporarily add a field to
`TicketSchema` in `src/extract.js` that the system prompt never mentions:

```js
escalationTeam: z.enum(['tier1', 'tier2', 'legal']),
```

Re-run. **Expect** `attempts: 2` or `3`, and a trace entry showing
`"ok": false, "problems": "escalationTeam: Required"` before the successful one.
**Remember to remove it afterwards.**

---

## 9. Input validation

```bash
curl -s -X POST http://localhost:8788/v1/agent -H 'Content-Type: application/json' -d '{}'
curl -s -X POST http://localhost:8788/v1/extract -H 'Content-Type: application/json' -d '{}'
```

**Expect:** `{"error":"`question` is required"}` and `{"error":"`email` is required"}`,
both with HTTP 400 (add `-i` to see the status).

---

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `hasGroqKey: false` | no key in `.env` |
| 404 `model does not exist` | model ID retired — `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"` and update `GROQ_TOOL_MODEL` |
| Agent loops to `max_iterations` | usually an unhelpful tool result; check what the tool returned |
| `Unknown tool "..."` in output | the model hallucinated a tool name — expected behaviour, handled gracefully |
| Extraction always `attempts: 1` | nothing wrong; the model is getting it right first time. See test 8 to force a failure |
