# Project 01 — Testing guide

Every feature built in this project, with the command to exercise it and what you should
see. Work top to bottom the first time.

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

---

## Setup

```bash
npm install                                    # once, from the repo root
npm run dev --workspace=01-streaming-gateway
```

Expected startup output:

```
▸ streaming gateway on http://localhost:8787
  demo UI:  http://localhost:8787/
  provider: mock (no API key needed) | groq | google
```

**Leave this terminal open and visible.** Three of the tests below are verified in the
*server terminal*, not on screen. Arrange your windows so you can see both.

---
---

# PART A — In the browser (start here)

Open **http://localhost:8787**

The page has: a **provider dropdown**, a **prompt box**, **Send** and **Stop** buttons, an
output area, and a small grey stats line underneath.

---

## A1. Streaming works

1. Leave the provider as **mock**, leave the prompt as-is.
2. Click **Send**.

**On screen:** words appear **one at a time**, left to right — not all at once. The stats
line fills in:

```
25 chunks · TTFT 47ms · total 1172ms
```

**In the server terminal:**

```
[start] provider=mock model=default
[done]  25 chunk(s) / 1172ms (TTFT 47ms)
```

**Proves:** SSE streaming end to end. **TTFT** (47ms) is when the *first* word appeared;
**total** (1172ms) is when the last one did. That gap is why streaming feels fast.

---

## A2. Each token is flushed immediately

1. Clear the prompt, type just **`slow`**.
2. Click **Send**.

**On screen:** the same sentence, but each word lands roughly every 400ms. You can watch
them arrive individually.

**Proves:** tokens aren't being batched up — Nagle is disabled and headers were flushed.
If words appeared in clumps, that would be the bug.

---

## A3. Retry with jitter — failure **before** the first word ⭐

1. Prompt: **`fail`**
2. **Send**

**On screen:** no words ever appear. After a moment, red error text:

```
[UpstreamError] mock returned 503: mock upstream is pretending to be down
```

**In the server terminal** — two retry lines, and the wait times must **differ**:

```
[retry] attempt 1/3 failed (UpstreamError: ...); retrying in 596ms
[retry] attempt 2/3 failed (UpstreamError: ...); retrying in 497ms
```

**Proves:** it retried three times. It was allowed to, because **nothing had reached your
screen yet**. Two identical wait numbers would mean jitter is broken.

---

## A4. Idle watchdog — failure **after** the first word ⭐

1. Prompt: **`hang`**
2. **Send**
3. The word **"Thinking"** appears. Then nothing.
4. **Now wait. Do nothing for a full 20 seconds.**

**The waiting is the lesson.** Nothing is broken. The connection is healthy, no error has
occurred, the server is fine. It would wait forever if you let it — that's exactly why a
watchdog has to exist.

**After ~20 seconds**, red text appears:

```
[IdleTimeoutError] Upstream stream stalled: no token for 20000ms
```

**Now compare A3 and A4 directly** — this is the most important comparison in the project:

| | A3 (`fail`) | A4 (`hang`) |
|---|---|---|
| Word reached the screen? | no | **yes** ("Thinking") |
| Retried? | **3 times** | **not once** |
| `partial` | `false` | `true` |

Same code, opposite decision — based purely on whether anything had already been sent.
Once a word is on screen you cannot un-send it, so retrying would splice two different
answers together.

> Impatient? Restart the server with a shorter timeout:
> `cd projects/01-streaming-gateway && IDLE_TIMEOUT_MS=2000 node --env-file=../../.env src/server.js`
> But do it the slow way **once** — 20 seconds of nothing teaches it properly.

---

## A5. Cancellation — the one that costs money ⭐

1. Prompt: **`slow`**
2. **Send**
3. When about half the words have appeared, click **Stop**.

**On screen:** the stats line reads `aborted by client`.

**In the server terminal:**

```
[abort] client disconnected after 12 chunk(s) / 4800ms — upstream call cancelled, we stop paying for the rest
```

**Compare the chunk count to A1's `25`.** You stopped at 12. Words 13–25 were never
generated and never billed.

**Proves:** the whole chain fired — browser abort → TCP close → `res.on('close')` →
`AbortController` → upstream torn down.

> Try it again and hit Stop almost immediately. The chunk count should be 1 or 2.

---

## A6. A real model

Requires `GROQ_API_KEY` in `.env`.

1. Change the dropdown to **groq**.
2. Ask a real question: *"Explain backpressure in two sentences."*
3. **Send.** Then Send again.

**Expect:** real text, and a **TTFT that changes between runs** (200–900ms) instead of the
mock's fixed timing. Words arrive in **irregular bursts** rather than a steady drip.

**Proves:** the crackly-line problem from the notes — real networks deliver data in clumps
that have nothing to do with word boundaries. Your buffering code is handling it.

> If you get an error about the model not existing, the provider retired it — see
> Part B test 7.

---

## Browser checklist

| # | Do | Look at | Pass if |
|---|---|---|---|
| A1 | Send (mock) | screen + terminal | words appear one by one; `[done] 25 chunk(s)` |
| A2 | prompt `slow` | screen | ~400ms between words |
| A3 | prompt `fail` | **terminal** | two `[retry]` lines, **different** ms |
| A4 | prompt `hang`, wait 20s | screen | one word, long silence, then error, **no retries** |
| A5 | `slow`, hit **Stop** | **terminal** | `[abort] ... after N chunk(s)`, N < 25 |
| A6 | dropdown → groq, Send twice | screen | TTFT differs between runs |

---
---

# PART B — Command line

**Tests 1 and 2 show you things the browser cannot** — the health endpoint and the raw
bytes on the wire. **Tests 3–7 are curl equivalents of A2–A6**, useful when you want to
script a check or capture exact output rather than clicking.

## 1. Health check

```bash
curl -s http://localhost:8787/healthz
```

**Expect:** `{"ok":true,"uptimeSec":3}`

---

## 2. The raw SSE wire format

The most important test — see the actual bytes.

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"hello"}]}'
```

**Expect** frames arriving one at a time, each separated by a **blank line**:

```
event: start
data: {"ttftMs":50,"provider":"mock","attempt":1}

event: delta
data: {"text":"This "}

event: delta
data: {"text":"is "}
...
event: done
data: {"tokens":25,"ttftMs":47,"totalMs":1172}
```

**Proves:** SSE framing, TTFT measurement, incremental delivery.

> ⚠️ `-N` disables curl's own buffering. **Without it curl shows everything at once at
> the end** and you'll wrongly conclude your server isn't streaming.

---

## 3. Throttled streaming

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"slow"}]}'
```

**Expect:** the same frames, but one every ~400ms so you can watch them land.

**Proves:** each token is flushed immediately, not batched (Nagle disabled,
`flushHeaders` working).

---

## 4. Retry with jitter — failure *before* the first token

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"please fail"}]}'
```

**Expect on the client:**

```
event: error
data: {"message":"mock returned 503: ...","type":"UpstreamError","retryable":true,"partial":false}
```

**Expect in the SERVER terminal** — two retry lines with **different** wait times:

```
[retry] attempt 1/3 failed (UpstreamError: ...); retrying in 596ms
[retry] attempt 2/3 failed (UpstreamError: ...); retrying in 497ms
```

**Proves:** retryable errors are retried; backoff is jittered (the two numbers must
differ — identical numbers mean jitter is broken); `partial:false` because nothing had
been sent yet.

---

## 5. Idle watchdog — failure *after* the first token

The default idle timeout is 20s. To avoid waiting, stop the server (`Ctrl+C`) and restart
it with a shorter one:

```bash
cd projects/01-streaming-gateway
IDLE_TIMEOUT_MS=2000 node --env-file=../../.env src/server.js
```

Then:

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"hang please"}]}'
```

**Expect** — one token, then ~2 seconds of silence, then an in-band error:

```
event: start
data: {"ttftMs":0,"provider":"mock","attempt":1}

event: delta
data: {"text":"Thinking"}

event: error
data: {"message":"Upstream stream stalled: no token for 2000ms","type":"IdleTimeoutError",
       "retryable":false,"partial":true}
```

**Proves three things at once:**

1. A stalled stream is detected even though nothing errored and the connection was healthy.
2. `partial: true` — a token had already been sent.
3. **No retry happened.** Compare with test 4, which retried 3 times. Same code, opposite
   decision, based purely on whether anything had reached the client.

> This is the single most important comparison in the project. Run 4 and 5 back to back.

---

## 6. Client disconnect → upstream cancellation

```bash
curl -N --max-time 1 -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"slow"}]}'
```

curl hangs up after 1 second. **Check the SERVER terminal:**

```
[start] provider=mock model=default
[abort] client disconnected after 2 chunk(s) / 1000ms — upstream call cancelled, we stop paying for the rest
```

**Compare with a completed run**, which logs instead:

```
[done]  25 chunk(s) / 1172ms (TTFT 47ms)
```

**Proves:** the full cancellation chain — TCP close → `res.on('close')` → `AbortController`
→ upstream torn down. **25 chunks vs 2** is the whole lesson: the rest were never
generated and never billed.

---

## 7. Real provider

Requires `GROQ_API_KEY` in `.env`.

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"groq","messages":[{"role":"user","content":"Explain backpressure in two sentences."}]}'
```

**Expect:** real text, and a TTFT that varies between runs (200–900ms) rather than the
mock's fixed timing. Tokens arrive in **irregular bursts**, not a steady drip — that
irregularity is the "crackly line" from the notes, visible in real life.

**If you get a 404 saying the model doesn't exist**, the provider retired it. List what's
current:

```bash
curl -s https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" | grep -o '"id":"[^"]*"'
```

Then update `GROQ_MODEL` in `.env`.

---

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Everything arrives at once | you forgot `-N` on curl |
| `EADDRINUSE :::8787` | a server is already running — find it: `netstat -ano \| grep 8787` |
| `GROQ_API_KEY is not set` | `.env` missing or empty; `cp .env.example .env` and fill it |
| 404 `model does not exist` | model ID retired — see test 7 |
| Retry waits are identical | jitter broken — `backoffMs()` should use `Math.random()` |
