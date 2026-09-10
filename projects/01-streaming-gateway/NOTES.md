# Project 01 — Streaming Gateway

**Skill:** running a slow, unreliable, non-idempotent upstream behind your own API,
while streaming partial results to a client that can vanish at any moment.

There is almost no "AI" in this project, and that's deliberate. This is the layer that
separates people who *call* an LLM from people who *operate* one. Every concept here is
classic backend work — it just gets applied to a stream of tokens instead of a REST call.

> **Read Part A first.** It explains everything with no jargon. Part B is the same
> material in professional vocabulary, for when you need the real words.

---
---

# PART A — The plain-English version

## What we're building

```
User's browser  →  YOUR server  →  Groq / Google's AI
```

You're building the thing in the middle. It exists because the browser must never hold
your API key, and because you need somewhere to log, limit, cache, and control the calls.
A middleman server like this is called a **gateway**.

## The one fact that causes every problem

**The AI writes one word at a time, like a person typing.** It doesn't have the answer
ready — it genuinely invents word 2 only after word 1 exists. A 200-word answer takes
~10 seconds to produce.

A **token** is just a chunk of a word (roughly ¾ of a word on average). "Streaming
tokens" means "sending little pieces of text as they're written." That's all it means.

So: wait for all 200 words and the user watches a spinner for 10 seconds — or forward
each word as it arrives and text appears after half a second. Same total time. The
second feels ten times faster. That's why ChatGPT types at you.

---

## The analogy: you run a phone hotline

A **customer** calls you with a question. You don't know the answer, so on a second phone
you call an **expert**. The expert slowly speaks the answer. Your job is to repeat each
word to the customer as you hear it.

| Hotline | Reality |
|---|---|
| The customer | The user's browser |
| You | Your server (the gateway) |
| The expert | Groq's / Google's AI |
| The expert charges by the minute | You pay per token |

Every problem below is a problem you'd genuinely have running that hotline.

---

### Problem 1 — Which kind of phone line?

The customer only listens. They ask once, then stay quiet while the answer comes. So you
don't need an expensive two-way line where both talk at once. A **one-way broadcast**,
like a radio station, is enough — simpler, and it works through every phone exchange
without special setup.

**That's SSE** (Server-Sent Events): server talks, browser listens, over ordinary web
plumbing so proxies and firewalls don't choke on it. The two-way option is a
**WebSocket** — you'd need it only if the customer had to interrupt mid-answer.

You send small text blocks, and **a blank line means "this block is finished":**

```
event: delta
data: {"text":"Hello"}
                        ← empty line = block complete
```

Forget the blank line and the browser waits forever for a block that never ends. No
error, just silence.

### Problem 2 — The line is crackly

The expert says *"the answer is fif—"* … *"—teen dollars."*

You heard two bursts. Repeat each burst as it lands and the customer hears **"fif"** then
**"teen"** — garbage. You must **wait until you've heard a complete block** before
repeating anything: hold the leftover `"fif"` in your head until `"teen"` arrives.

**In code this is buffering.** The internet delivers data in arbitrary bursts that have
nothing to do with where your blocks end. One burst may be half a block; the next may
hold three.

⚠️ **This is the nastiest bug here**, because on your laptop the bursts happen to line up
and everything works. It only breaks on real networks, ~1 request in 500, and you will
never reproduce it locally.

### Problem 3 — The customer hangs up

The customer closes the tab. **The expert has no idea.** They keep talking for another
15 seconds — still charging you by the minute.

You must **actively hang up on the expert too.** It does not happen by itself.

The tool for this is an **AbortController** — a fire alarm with one button. Everything
that should cancel the call (customer hung up, expert went silent, server shutting down)
presses that same button.

**The classic mistake:** you stop *listening* to the expert but never hang up. You've
stopped hearing them; they haven't stopped talking or charging. In code, that's
forgetting to hand the alarm to the call itself — `fetch(..., { signal })`.

### Problem 4 — The expert goes quiet

The expert says *"The answer is…"* and then nothing. You can hear them breathing. The
line is fine. They've just stopped.

**Nothing detectable has gone wrong.** No error, no disconnection. You'd wait forever.

House rule: **"no word in 20 seconds → assume broken, hang up."**

Why that rule instead of "hang up after 60 seconds total"? Because a total limit can't
distinguish a genuinely long, useful 90-second answer ✅ from an expert who died 5
seconds in ❌. Set it low, you cut off good answers; set it high, broken calls linger.
**The gap between words tells you instantly** — a healthy expert never pauses 20 seconds,
a dead one pauses forever.

This is the #1 way these servers fall over in production: dead calls pile up invisibly
because nothing ever raises an error.

### Problem 5 — You can't un-say words ⭐

The most important one, and the classic interview question.

- **Line drops before the expert speaks** → quietly redial. Customer never knew. Fine.
- **Expert says "The answer is fifteen—" then drops** → you redial, the new expert starts
  over, and the customer hears:

  > "The answer is fifteen… **The answer is twenty-two dollars.**"

  Two different answers spliced into nonsense. **You cannot take back words already said.**

**The rule: you may only retry before the customer has heard anything.** After that, the
only honest move is "sorry, we got cut off."

This is why the code tracks `firstTokenAt`. In our tests the `fail` case retried 3 times
(nothing sent yet) while the `hang` case sent one word first, refused to retry, and
reported `partial: true`. Same code, opposite decision.

### Problem 6 — You already said "yes"

At the start you told the customer **"Sure, here comes your answer."** That promise is
out of your mouth. If the expert dies 40 words later you can't go back and say "actually,
error." You can only say it *inside the conversation*: "…and I'm sorry, we've lost the
connection."

In HTTP terms: starting a stream already sent **status 200 = success**. The status code
is spent; you can't switch to a 500. Errors must be delivered as a normal message in the
stream. The consequence people miss: **your client must expect an error even after a
successful response started.**

### Problem 7 — Don't all redial at once

The expert's phone system overloads and rejects everyone at once. All 500 operators wait
exactly 1 second and redial simultaneously — **crashing it again.**

Fix: everyone waits a *random* amount, spreading the load. That's **jitter**. In our test
the two waits were 596 ms and 497 ms, not identical.

---

## Part A summary

| Hotline problem | Real name | What breaks without it |
|---|---|---|
| Repeat words as you hear them | streaming | user waits 10s at a spinner |
| One-way radio, not a two-way line | SSE | needless complexity |
| Wait for complete blocks on a crackly line | buffering | random garbage, only in production |
| Hang up on the expert too | cancellation / AbortController | you pay for unread words |
| Expert went silent — hang up | idle timeout | dead calls pile up, no error |
| Can't un-say words | retry only before first token | two answers spliced together |
| Already promised "yes" | in-band errors | can't report failures mid-stream |
| Don't all redial at once | jitter | you re-crash the provider |

---
---

# PART B — The professional vocabulary

Same ideas, in the words you'll meet in docs, code review, and interviews.

## 1. Why stream at all

An LLM generates tokens **serially**. A 400-token answer takes as long as 400 sequential
forward passes. Buffer it and the user stares at a spinner for 5–20 seconds.

The metric that matters is **TTFT — Time To First Token**, not total duration.
A response that starts in 300 ms and finishes in 12 s feels dramatically faster than
one that arrives complete at 6 s. Perceived latency is TTFT; total duration is
throughput. Instrument both, optimise the first.

## 2. SSE vs WebSockets vs long polling

| | Direction | Reconnect | Proxy-friendly | Fit |
|---|---|---|---|---|
| **SSE** | server → client | built into `EventSource` | yes, plain HTTP | ✅ LLM output |
| WebSocket | bidirectional | you write it | needs upgrade support | overkill here |
| Long polling | request/response | n/a | yes | wasteful |

LLM output only flows one way, so SSE's simplicity wins. It's ordinary HTTP with a
`text/event-stream` content type, so proxies, CDNs, and HTTP/2 handle it natively.

**The wire format** — frames separated by a **blank line**:

```
event: delta
data: {"text":"Hello"}
                        ← this blank line terminates the frame
```

Gotchas that cost people hours:
- Forget the `\n\n` and the client buffers forever with no error.
- Each *line* of the payload needs its own `data: ` prefix. An embedded newline
  silently splits your payload into two fields.
- `:` starts a comment line — that's how heartbeats work.

## 3. Four headers and a socket option that make streaming actually stream

```js
'Content-Type':      'text/event-stream; charset=utf-8'
'Cache-Control':     'no-cache, no-transform'   // no-transform stops proxy gzip buffering
'Connection':        'keep-alive'
'X-Accel-Buffering': 'no'                       // nginx: don't buffer the upstream response
res.flushHeaders()                              // send the 200 now, not on first write
res.socket.setNoDelay(true)                     // disable Nagle — see below
```

**Nagle's algorithm** batches small writes to reduce packet overhead. That's the exact
opposite of what a token stream wants: every token is a small write and we want it on
the wire immediately. Leaving Nagle on produces a characteristic ~40–200 ms stutter that
looks like "the model is slow" but is entirely your TCP stack.

## 4. Chunk boundaries ≠ frame boundaries ⚠️

The most common real bug in this layer.

A TCP chunk has **no relationship** to an SSE frame. One chunk may contain half a
`data:` line; the next may contain three frames. Parsing chunk-by-chunk gives you
intermittent `JSON.parse` errors that only appear under load or on slow networks and
never reproduce on localhost.

**Fix:** accumulate into a buffer, consume only complete `\n\n`-terminated frames,
leave the remainder in the buffer.

Same applies to text decoding: a multi-byte UTF-8 character can be split across chunks.
`new TextDecoder()` with `decode(chunk, { stream: true })` holds the partial bytes
instead of emitting a `�`. Emoji and non-ASCII text are where this shows up.

## 5. Cancellation — the one that costs money

**When the client disconnects, the provider neither knows nor cares.** It keeps
generating tokens and keeps billing for them.

The chain that has to be intact:

```
browser abort → TCP close → server `res.on('close')` → AbortController.abort()
              → fetch(signal) tears down upstream → provider stops generating
```

Break any link and you have a leak. The most common break is not passing `signal` into
`fetch` — then "cancelling" only stops you from *reading*, while generation continues.

On a free tier this is quota. On a paid tier it's a line item. In both cases it's also
a socket and memory leak on your own box.

## 6. Two different timeouts, and why one isn't enough

**Connect timeout** — bound the time to first response *headers*. Arm a timer before
`fetch`, clear it once headers arrive.

**Idle timeout (watchdog)** — bound the gap *between tokens*.

Do **not** put a total-duration timeout on a streaming request: it can't distinguish a
long-but-healthy answer from a stalled one, so you either kill good responses or allow
infinite hangs.

The failure this catches: **a hung stream does not error**. The TCP connection stays open
and healthy, the provider just stops sending. Nothing throws, `for await` blocks forever,
and the handler leaks until you restart the process. This is the most common way an LLM
gateway falls over.

Implementation is a race per iteration:

```js
result = await Promise.race([iterator.next(), rejectsAfter(ms)]);
```

…and on timeout you **must** abort the controller, or the underlying fetch leaks anyway.

## 7. Retry semantics under streaming ⚠️ (the interview favourite)

> **You can only retry before the first byte reaches the client.**

Once one token is out, the HTTP 200 and those bytes are on the wire and cannot be
recalled. A retry restarts generation from scratch, so the client would render the first
half of answer A followed by the whole of answer B. There is no transparent recovery.

- **Before first token:** retry freely (if the error is retryable).
- **After first token:** stop. Report the break and let the client decide.

**Retryable:** 429, 5xx, connect timeout, DNS/TCP/TLS failures.
**Not retryable:** 400 (malformed), 401 (bad key), 404 (bad model) — identical request,
identical failure, so retrying only burns rate limit and adds latency.

**Backoff needs full jitter.** Plain exponential backoff *synchronises* clients: a
provider rate-limits everyone at once, every client waits exactly 1 s, and they all
retry in the same millisecond — recreating the spike.

```js
const wait = Math.random() * Math.min(1000 * 2 ** (attempt - 1), 8000);
```

## 8. You cannot send an error status mid-stream

By the time the first token flows you have already committed to `HTTP 200`.
The status code is **spent**. Any later failure must travel **in-band**:

```
event: error
data: {"message":"...","retryable":true,"partial":true}
```

This means your client must be written to expect an error event *after* a successful
200 — a shape most HTTP clients don't naturally handle. Design the contract explicitly.

## 9. EventSource can't do this

The browser's built-in `EventSource` only issues **GET** requests, with no custom headers
and no body. You can't send a chat payload or an `Authorization` header. So real LLM
frontends use `fetch` + `ReadableStream` and parse SSE by hand — which is why the demo
page reimplements the same buffering logic client-side.

## 10. Node server settings for long-lived responses

```js
server.keepAliveTimeout = 65_000;  // default 5s would close sockets mid-thought
server.headersTimeout   = 66_000;  // must exceed keepAliveTimeout
server.requestTimeout   = 0;       // no total cap; the idle watchdog is the safety net
```

---

## Experiments to actually run

| Command | What it proves |
|---|---|
| Send with `mock` | SSE frames arriving incrementally; TTFT in the stats line |
| Prompt contains `slow` | Throttled generation — watch tokens land one at a time |
| Prompt contains `fail` | Retry with jitter; check the server log for attempt counts |
| Prompt contains `hang` | Idle watchdog fires after `IDLE_TIMEOUT_MS`; error arrives in-band |
| Press **Stop** mid-stream | Full cancellation chain; server logs `client disconnected` |
| `curl -N` the endpoint | See the raw wire format with your own eyes |

```bash
curl -N -X POST http://localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"provider":"mock","messages":[{"role":"user","content":"hello"}]}'
```

`-N` disables curl's own buffering. Without it curl shows everything at once and you'll
wrongly conclude your server isn't streaming.

---

## Self-test

The questions and answer keys for this project live in `PRACTICE.md`, which is
gitignored — it's for personal recall practice, not for readers of this repo.

If it's missing (fresh clone), the questions cover: why streaming feels faster, SSE vs
WebSockets, chunk-vs-frame boundaries, the full cancellation chain, connect vs total vs
idle timeouts, the retry-before-first-byte rule, in-band error reporting, jitter, and
why `EventSource` can't be used here.

---

## What carries into project 02

The `streamChat` generator and the SSE plumbing become the transport for **tool calling**,
where the stream carries structured tool-call deltas instead of plain text — and where
partial JSON has to be reassembled across chunks before it can be validated.
