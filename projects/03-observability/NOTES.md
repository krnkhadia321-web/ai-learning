# Project 03 — Observability

**Skill:** seeing inside a system whose failures don't raise errors — tracing LLM calls,
attributing cost to people and features, and recording what was said without leaking it.

> **Read Part A first.** No jargon. Part B is the same material in professional
> vocabulary. Self-test questions are in `PRACTICE.md` (gitignored).

---
---

# PART A — The plain-English version

## The story so far — what all these words mean

Projects 01–03 share one running picture. Here it is from scratch, assuming nothing.

### You run a telephone hotline

You're a call-centre operator sitting at a desk. People phone you with questions about
their online orders, and it's your job to answer them.

### The customer

A person who phones in. *"Where is my order?"* They're on the line, waiting.

> **In real terms:** a user in their browser.

### You, the operator

**You are the only one in this story who actually does anything.** You answer the phone,
you make calls, you walk around the office, you speak the final answer down the line.

> **In real terms:** your Node server — the code you write. Every single thing that
> happens, happens because your code did it.

### The expert

Someone you can phone for help. They're brilliant at understanding a messy question and
phrasing a good answer — but they are **locked in a windowless room**. No phone of their
own, no internet, no computer, no calendar, **no clock**. They can only think and talk.

> **In real terms:** the AI model (Groq's LLM), reached over the internet.
>
> "Locked in a room" isn't decoration — it's literally true. The model cannot look
> anything up, cannot run anything, and does not know what time it is. It can only
> produce text.

**And the expert charges you by the minute.** → you pay the AI provider per token.

### The filing cabinet

Where the real facts live: order records, product prices, the clock on the wall. It sits
in your office, and **only you can walk to it.** The expert can't — they're locked in.

> **In real terms:** your database and your own functions. These are the `tools` from
> project 02, like `get_order_status()`.

### Sliding notes under the door

Since the expert can't reach the cabinet, when they need a fact they **write a note and
slide it under the door**: *"please look up order A-1001."*

You pick up the note, walk to the cabinet, and slide the answer back underneath. The
expert reads it and carries on.

> **In real terms:** a tool call. The model *requests*; your server *decides and does*.

### Putting it together

One customer question usually looks like this:

```
customer phones you                       ← a request arrives at your server
  you phone the expert                    ← a model call (costs money)
  expert slides a note under the door     ← the model requests a tool
  you walk to the filing cabinet          ← your server runs a function
  you slide the answer back               ← the tool result goes to the model
  you phone the expert again              ← another model call (costs money again)
  expert gives you the final wording
you tell the customer                     ← the response goes back
```

### The full mapping

| In the story | In your code |
|---|---|
| The customer | a user in their browser |
| **You, the operator** | **your Node server — the only thing that executes anything** |
| The expert, locked in a room | the AI model, over HTTPS |
| The expert charging by the minute | paying per token |
| The filing cabinet | your database and functions (`tools.js`) |
| Walking to the cabinet | your server running a tool |
| A note under the door | the model *requesting* a tool call |
| One customer phone call | one request → one **trace** |
| One leg of it (a call, a cabinet trip) | one **span** |

> **Project 03 is about exactly one thing: writing all of that down.**

### One more word: telemetry

**Telemetry = measurements a system sends about itself, while it runs, to somewhere you
can read them.**

The word is *tele* (far) + *metron* (measure) — "measuring from a distance." It comes
from rocketry: nobody can ride inside the rocket, so the rocket carries sensors that
radio their readings back to mission control — temperature, pressure, fuel, altitude.

Your server has the same problem. It runs on a machine you aren't watching, doing
thousands of things a second. Telemetry is what it radios out.

In the hotline, telemetry is **everything you write down and send out of the office**:

| What you write down | The name for it |
|---|---|
| The record of one customer call | a **trace** |
| Monthly totals — calls handled, total spend | **metrics** |
| Scribbled notes: "expert sounded confused here" | **logs** |

Those three are the standard categories.

> **Telemetry is data *about* the work, not the work itself.** Answering the customer is
> the work. Writing down that the call took 2.9s and cost $0.0002 is telemetry.

And note why the standard is called Open**Telemetry** rather than "OpenLogging": you
already know logging — `console.log`, lines in a file. Telemetry is the umbrella term
covering logs *plus* traces *plus* metrics, and it implies the data is **structured and
shipped somewhere else to be queried**, not just printed and eyeballed.

### And one more: the ledger

**A ledger is an accounting book where every transaction gets one line** — date, item,
amount — so you can add up the column at the end of the month.

In the hotline, it's a second notebook next to your call log. After every call you write
a single line:

```
09:14  u_1   gpt-oss-20b   348 in / 44 out   482ms   $0.000039
09:16  u_1   gpt-oss-20b   870 in / 61 out   910ms   $0.000081
09:21  u_2   gpt-oss-20b   402 in / 38 out   500ms   $0.000045
```

**Trace and ledger answer different questions:**

| | Answers | Scope |
|---|---|---|
| **Trace** | *"What happened in **this** request?"* | one request, full detail |
| **Ledger** | *"What is this costing me across **all** requests?"* | every request, one line each |

A trace tells you why one conversation took 3 seconds. Only a ledger tells you that user
`u_1` accounts for 80% of your spend.

In this project the ledger is an array in `src/genai.js`: `recordCall()` appends a line,
`usageSummary()` totals and groups it, and `GET /v1/usage` returns it — that's what the
**Ledger** panel at the bottom of the demo page renders. It's deliberately independent of
Jaeger so measurement works with no Docker running.

⚠️ Ours is in-memory and capped at 500 entries, so it dies on restart. A real one writes
to a database you can query historically — otherwise you can't answer "what did we spend
last month?"

---

## The bill arrives

You've been running the hotline for a month. It works. Customers are happy.

Then the bill arrives: **₹40,000.**

You have no idea why. Was it one customer who called 500 times? Was one expert
rambling for twenty minutes per question? Were you walking to the filing cabinet
needlessly? **You kept no records, so you cannot answer a single one of those
questions.** All you can do is pay it and hope next month is cheaper.

So you start keeping a **call log**. For every customer call you write down:

- when it started and how long the whole thing took
- each expert you phoned, and how long each one took
- every trip you made to the filing cabinet
- how much each leg cost

That log is a **trace**. Each leg — one expert call, one filing-cabinet trip — is a
**span**. Spans nest inside each other, so one customer call looks like this:

```
customer call "where is my order?"          2.9s   $0.00017
├── phoned the expert (round 1)             0.9s   $0.00004
├── walked to the filing cabinet            0.01s  free
├── phoned the expert (round 2)             1.1s   $0.00006
├── checked the clock                       0.00s  free
└── phoned the expert (round 3)             0.9s   $0.00007
```

Read that top to bottom and you can see **exactly what happened, in order, with the
cost of each step.** No amount of scattered log lines gives you that shape.

And here is that *same tree* as it actually appears in Jaeger — the names come straight
from the code, so you can match them line for line:

```
POST /v1/agent                              ← the customer's call arriving
└── invoke_agent support-agent              ← you handling the whole question
    ├── chat openai/gpt-oss-120b            ← phoned the expert (round 1)
    ├── execute_tool get_order_status       ← walked to the filing cabinet
    ├── chat openai/gpt-oss-120b            ← phoned the expert (round 2)
    ├── execute_tool get_current_time       ← checked the clock
    └── chat openai/gpt-oss-120b            ← phoned the expert (round 3)
```

`chat …` spans cost money (you're paying the expert by the minute). `execute_tool …`
spans are free and fast — that's your own code walking to your own cabinet.

**If a trace has lots of `chat` spans and no `execute_tool` spans, the expert answered
from imagination instead of checking the facts.** That single shape is what catches the
"right answer, wrong process" failure below.

---

## Problem 1 — Every dashboard is green while the product is broken

### The scenario

A customer phones and asks when their order will arrive. The expert answers:

> *"Your order was delivered last Tuesday."*

It was never even shipped. The customer is furious.

You go and check your monitoring — the normal kind, the kind you already know how to
build. Response code **200**. Latency **400ms**. Error rate **0%**. Uptime **100%**.
Every graph is green.

**Your monitoring is not broken. It answered the question it was asked.** It watched
whether the *machinery* worked — and the machinery worked flawlessly. It delivered a
sentence in 400ms with no errors. Nobody ever asked whether the sentence was **true**.

### Why normal monitoring structurally cannot catch this

Think about an ordinary endpoint, `GET /orders/A-1001`. It either returns the record or
it throws. Its correctness is **structural**: if the database row says `shipped`, the
endpoint returns `shipped`. There is no path by which it returns `delivered` unless the
data says so. So "it returned 200" really does imply "it was right."

An LLM doesn't look anything up — **it writes a plausible sentence.** Plausible and true
are different properties, and the machine can only check one of them.

> Normal monitoring answers *"did it work?"*. Here you also need *"was it right, what did
> it cost, and how did it get there?"* — and none of those have a status code.

### The fix

Two parts, and it's important to be honest that observability only delivers the first.

**1. Record the words.** Without the actual text there is no evidence at all — you cannot
investigate a complaint about an answer you never kept. In `llm.js`:

```js
captureContent(span, 'gen_ai.input.messages', messages);   // what we asked
captureContent(span, 'gen_ai.output.messages', message);   // what it said
```

That's what lets a human — or later, a judge model — look at it afterwards.

**2. Record the outcome signals that *do* exist.** Some failures leave a fingerprint even
though the status is 200:

| Attribute we record | What it catches |
|---|---|
| `gen_ai.response.finish_reasons` = `length` | the answer was **cut off mid-sentence** by the token limit — a definite failure, returned as 200 |
| `gen_ai.tool.outcome` = `validation_failed` | the model produced arguments your code rejected |
| `gen_ai.agent.halted_reason` = `max_iterations` | it gave up without ever answering |
| span status = `ERROR` | the call actually threw |

⚠️ **The honest limit:** none of this tells you the answer was *wrong*. A confident
fabrication has `finish_reason: stop` and looks identical to a perfect answer.

> **Observability makes wrongness *investigable*. It does not make it *detectable*.**
> Automatic detection needs evals — that's project 06. Project 03's job is to guarantee
> that when someone reports a problem, **the evidence exists.**

## Problem 2 — Right answer, wrong process

### The scenario

This one actually happened to us in project 02, which is why it's here.

We asked: *"How many days until my order A-1001 arrives?"*
The model answered: *"That's 3 days from today."*

**Correct.** Order arrives the 9th, it was the 6th. Three days. You'd tick it off as
working and move on.

Then we looked at what actually happened, and the expert **never checked the clock.**
There is no clock in the locked room. It had no idea what today's date was. It made up a
number, and the number happened to be right.

### Why this is worse than a plain bug

Tomorrow the same code gives the same answer — *"3 days"* — when the truth is 2. Nothing
will have changed. Nothing will have broken. **It was never working.**

And note what your test did: you asked once, got the right answer, and concluded the
feature worked. **Testing it actively misled you.** A normal bug hides until you hit it;
this one hides *behind a correct answer*, which is a far better disguise.

Everything else is clean too — output looks perfect, latency fine, no error, `finish_reason:
stop`. Every signal from Problem 1 says success.

### The fix

Stop judging by the answer. **Record which trips to the filing cabinet actually
happened**, and judge by that instead.

In `agent.js`, every successful tool run appends its name, and the list goes on the root
span at the end of the run:

```js
if (event.type === 'tool_result') toolsUsed.push(event.name);
...
rootSpan.setAttributes({ 'gen_ai.agent.tools_used': toolsUsed });
```

The demo page surfaces the same thing as a card labelled **"tools actually used"**, which
prints **⚠ none** when the list is empty.

**The check you can now make**, which was impossible before:

> For any question whose answer depends on live data — a date, a price, an order status —
> an **empty `tools_used` list means it guessed**, no matter how right the answer looks.

And in the trace waterfall it's a shape you can spot at a glance:

```
✅ healthy                          ❌ guessed
invoke_agent                        invoke_agent
├── chat …                          ├── chat …
├── execute_tool get_current_time   └── chat …
└── chat …                              ↑ no execute_tool spans at all —
                                          answered from imagination
```

> **Lots of `chat` spans and no `execute_tool` spans = the expert never opened the filing
> cabinet.**

### Seeing it on demand

You can't reproduce this by hoping the model misbehaves — a capable model usually *does*
call the clock. So take the clock away instead:

```bash
DISABLE_TOOLS=get_current_time node --env-file=../../.env src/server.js
```

Measured on 10 Sep 2026, with order A-1001 due 9 Sep:

| | Clock available | Clock removed |
|---|---|---|
| Answer | *"ETA 9 Sep, today is 10 Sep, should have already arrived"* ✅ | *"expected to arrive in 1 day"* ❌ |
| `tools_used` | `get_order_status, get_current_time` | `get_order_status` |
| HTTP status | 200 | 200 |
| Error raised | none | none |

The second answer is **wrong** — the order was already a day late, and the model said it
arrives tomorrow. It invented today's date, missed by two days, and stated it as fact.

Same model, same question, same code. **The only signal separating a correct answer from
a wrong one is the tool list.**

And this isn't a lab trick. A tool disappearing from the model's options is a real
production failure — rate-limited, throwing on registration, or a mistyped name in a
config. It vanishes silently, and the model **papers over the gap with a guess** rather
than failing loudly.

## Problem 3 — Cost is the metric that behaves differently

> **Reminder: what a "token" is.** A chunk of a word — roughly ¾ of a word on average.
> "Hello" is 1 token; a longer word might be 3. It's the unit the AI provider counts and
> bills you for. **Input tokens** = the text you sent (the question, the conversation so
> far, the tool results). **Output tokens** = the text the model wrote back.
>
> In the story: tokens are the *minutes* on the expert's bill.

### The scenario

Your spend has been steady for weeks. Then one day it **triples**. Traffic did *not*
triple — you're serving roughly the same number of customers as last week.

What happened? It could be any of these:

- one user having unusually long conversations
- someone switched the model
- questions started needing more rounds with the expert
- a bug making the agent loop more than it should

**Without a cost figure attached to each individual request, you cannot tell which.**
You just have a bigger number and a guess.

### Why cost behaves unlike any resource you've managed

Every other resource is roughly fixed: your server costs the same whether it handles 10
requests or 100. You provision it and it sits there.

**Model calls cost money per call, and the amount is not flat.** It scales with how much
text goes in and how much comes out. So one user asking a single unusually expensive
question can cost more than a thousand ordinary ones.

There's a second, sneakier reason costs climb. **Every time you phone the expert back,
you have to repeat the entire conversation so far** — they have no memory between calls.
So round 3 resends everything from rounds 1 and 2. A conversation that takes six rounds
doesn't cost 6× a single round; it costs considerably more, because each round carries
all the previous ones with it.

> That's why the iteration cap from project 02 is a **cost** control, not just a safety
> net — and why the trace showing *how many* `chat` spans a question needed is worth
> looking at.

Two things fall out of that:

**Output text costs several times more than input text.** Rough shape: reading is cheap,
writing is expensive. This is why *"keep replies short"* in a system prompt is a genuine
cost control, and why stuffing lots of reference material into the input is cheaper than
people assume.

**You pay for thinking you never see.** Some models produce internal "reasoning" tokens
before their actual answer. You are billed for those, and they never appear in the
output. We measured this in project 02: **157 of 218 output tokens were reasoning — 72%
of what we paid for was invisible.**

### The fix

Cost isn't reported to you — **you compute it yourself** from the token counts the
provider returns, and then you attribute it to someone.

**1. Compute it per call.** The provider tells you tokens; you supply the price table
(`genai.js`):

```js
cost = (input_tokens × input_rate) + (output_tokens × output_rate)
```

**2. Attach *who* and *what* to every record.** This is the step that turns a number into
a decision — without it you have "the LLM cost $400" and nothing else:

```js
recordCall({ operation, userId, model, inputTokens, outputTokens, usd, ... });
```

**3. Record reasoning tokens separately.** They're billed at the output rate and never
appear in the response, so if you count only visible text your cost model is wrong by a
factor of three.

**4. Flag estimates.** If the model isn't in your price table we fall back to a default
rate and set `cost_estimated: true`. Without that flag, an unpriced model silently drifts
your dashboard away from the real invoice with no warning.

**5. Total it on the root span**, not just per call — so you can sort traces by *most
expensive conversation* and open the worst one. Per-call cost never tells you which
customer question was pathological.

**6. Aggregate it.** `/v1/usage` rolls the ledger up `byModel`, `byUser`, `byOperation`.

Now the tripled bill is answerable in one look: which model, which user, which feature.

> **The number that matters isn't "we spent $400 last month."** It's *"the support agent
> costs $0.02 per conversation, and user u_7 had 3,000 of them."* The first is trivia.
> The second is a decision.

⚠️ **And measure cost per *completed conversation*, not per call.** A cheaper model that
needs more rounds — each one resending the whole history — can cost more in total. That's
the experiment at the end of these notes, and it's the reason per-call pricing alone
misleads you.

### ⚠️ In this project, the dollar figures are simulated

Worth being blunt about, because the UI shows `$0.000169` as if it were a fact.

**The provider gives you tokens. It never gives you money.** All the API returns is:

```json
"usage": { "prompt_tokens": 348, "completion_tokens": 44 }
```

The **price per token is a constant hardcoded in `genai.js`** — the `PRICING` table. And
those rates are **unverified placeholders**, as the file itself says. Meanwhile you're on
Groq's free tier, so your actual bill is **$0.00**.

| | Real or invented |
|---|---|
| Token counts | **real** — measured and returned by the provider |
| Latency, model, iterations, tools used | **real** |
| Price per token | **invented** — a placeholder table |
| Therefore the $ figures | **simulated** |

Here is a genuine ledger line, worked through, so you can see exactly where the number
comes from:

```
model: openai/gpt-oss-20b        input $0.075/1M     output $0.300/1M

(348 × 0.075) + (44 × 0.300)  =  26.1 + 13.2  =  39.3
39.3 / 1,000,000              =  $0.0000393
```

Note the split: **output was 11% of the tokens but 34% of the cost.** The input/output
asymmetry, visible in one line of arithmetic.

**So why simulate it at all?** Because the mechanism transfers and the constants don't.
The code path is identical to production — compute per call, attribute to a user and an
operation, split out reasoning tokens, total on the root span, aggregate in the ledger.
Moving to a paid provider means editing one table; nothing else changes.

And every **relative** conclusion in these notes still holds, because the same table is
applied throughout:

- multi-step costing ~4× a single call, not 3× ✓
- output tokens dominating the spend ✓
- a cheaper-per-token model costing more overall because it needs more rounds ✓

Only the absolute amounts are fictional. **Never quote a figure from this project as a
fact about a provider's pricing.**

## Problem 4 — Recording the calls means recording what people said

### Why you'd want to record at all

Go back to Problem 1: the answer can be **completely wrong while every dashboard stays
green.** No error, no status code, nothing to alert on.

So how do you ever discover a bad answer? **You look at what was actually said** — the
question asked and the answer given. There is no other way. The words *are* the evidence.

So you decide to record the calls.

### Why that's a problem

Customers say real things out loud:

> *"Hi, my email is anshul@gmail.com, my number is 98765 43210, I paid with card
> 4111 1111 1111 1111, and I live at 14 Nehru Road…"*

Record the call and you have recorded **all of it**.

Now the part people skip: **where do the recordings go?** Not a drawer in your own
office. Monitoring services are almost always *another company's servers* — Datadog,
Honeycomb, Langfuse. You send them your data; they store it.

So the honest sentence is:

> **You are taking your customers' card numbers and posting them to a company your
> customers have never heard of.**

That is not a technical choice you make casually while debugging. It's a legal and
privacy decision, and in a real company it involves people other than you.

*(The term you'll see is **PII** — Personally Identifiable Information. It means anything
that identifies a real person: name, email, phone, address, card, ID number.)*

### The three settings

Three ways to keep a record of a phone call:

**1. `full` — record the whole call, every word.**
Perfect evidence. Also: you are now holding everyone's card numbers. Only sane when the
"customers" are you, testing with made-up data on your own laptop.

**2. `redacted` — record the call, but bleep the sensitive bits.**
Like a TV broadcast bleeping swear words. The recording still reads *"my email is
[email] and my card is [card]"* — you can still see the shape of the conversation and
judge whether the answer was any good, but the actual values are gone.

**3. `none` — keep the phone bill instead of the recording.**
An itemised phone bill says: this call lasted 2.9s, you rang the expert 3 times, you
opened the filing cabinet twice, it cost $0.0002. It says **nothing about what was said.**

> That's what **metadata** means: facts *about* the call, not the contents of it. You
> lose the ability to judge quality, but you hold nothing sensitive at all. For genuinely
> regulated data (health, finance) that's the correct answer, not a compromise.

| Mode | What's recorded | When to use it |
|---|---|---|
| `full` | every word | local development, fake data |
| `redacted` | words with known patterns bleeped | the sensible default |
| `none` | the phone bill only — timings, token counts, tool names | regulated data |

### ⚠️ Why bleeping is not a guarantee

A bleep machine works off a list of **known patterns**. It recognises
"something@something.com" and "sixteen digits in a row."

It cannot bleep what it doesn't recognise:

> *"My mother's maiden name is Kaur and I live opposite the temple on Nehru Road."*

No pattern matches that. It goes straight into the recording.

So redaction is genuinely useful **and** genuinely not a guarantee. The mistake to avoid
is telling your compliance team "we redact PII" as though that settles it. It reduces
exposure; it does not eliminate it. When the data is truly regulated, use `none`.

### The bug we actually hit

The bleep machine checks its rules **in order, first match wins.** Mine were:

```
rule 1: a long run of digits   → bleep as [phone]
rule 2: sixteen digits         → bleep as [card]
```

A card number *is* a long run of digits — so rule 1 caught it first, and every card came
out labelled `[phone]`. Nothing leaked, since it was still hidden. But the **labels were
wrong**, which matters the moment someone asks "do we ever store card numbers?" — your
logs would claim you only ever saw phone numbers.

**Fix: most specific rule first.** Cards before phones. Then test it, because you cannot
eyeball this.

## Problem 5 — "It gave me nonsense yesterday"

### The scenario

A customer emails you:

> *"I called your hotline yesterday about my order and it told me complete nonsense."*

Now go and find that call. What do you actually have?

- Thousands of calls happened that day
- You don't know what time they rang
- You don't know exactly what they asked
- You may not even know which customer they are

You'd be scrolling recordings by timestamp, guessing. It could take an hour. You might
never find it. And until you find it you can't fix anything — you're debugging a *story*
instead of a *record*.

### The fix is a shop receipt

When you buy something, the shop prints a unique number on your receipt. Come back to
complain and you hand over the receipt; they look up **exactly** that transaction in
seconds. Nobody scrolls through the day's sales.

So: at the start of every call, generate a unique number, write it at the top of that
call's record, and **give it to the customer**.

Now *"it gave me nonsense yesterday, reference `a3f8b2c1`"* is a five-second lookup.

### In code

That number is the **trace ID** — every span in the trace shares it. We return it in the
`X-Trace-Id` response header, and the demo page prints it with a link straight to that
trace in Jaeger.

Real applications put it on the error screen: *"Something went wrong. Reference:
a3f8b2c1."* Support asks for it first.

```js
res.setHeader('X-Trace-Id', span.spanContext().traceId);
```

One line, and it converts "unreproducible complaint" into "open this exact run."
Nothing else in this project has that ratio.

## Problem 6 — Don't log the doorbell

### The scenario

You have an automatic system that rings your hotline **every 5 seconds** just to check
the phone line still works. It says nothing, hangs up, rings again.

That's your **health check**. Every server has one, so the infrastructure around it knows
the process is still alive.

Now suppose you write a full call record for each ring:

```
every 5 seconds   →  17,280 records per day
real customers    →  maybe 200 calls per day
```

Your call log is now **99% "the line is fine, the line is fine, the line is fine"** and
1% actual customers. Finding a real call means scrolling past thousands of useless
entries.

And monitoring services **charge by volume**. So you're also paying to store "the line is
fine" seventeen thousand times a day. On a paid backend, the doorbell genuinely becomes
most of your bill.

### The fix

The fix doesn't look like a fix, because it isn't a technique — it's the **absence** of
one. You simply don't write the boring calls down.

**First, what "writing it down" means in code.** When we want to trace a request we call
`tracer.startActiveSpan(...)`. That one call sets off a chain:

1. creates a span object in memory
2. gives it a trace ID
3. starts a timer
4. when it ends, queues it to be sent over the network to Jaeger
5. Jaeger receives it and stores it

**That whole chain is "writing the call down."** So "don't write it down" literally means
*don't call `startActiveSpan`.*

**Second, how you avoid calling it.** Node checks route conditions top to bottom. Look at
the real shape of `src/server.js`:

```js
http.createServer((req, res) => {

  if (url.pathname === '/healthz') {          // ← line 39
    return json(res, 200, { ok: true });      // ← line 40: RETURNS HERE. Done.
  }                                           //   No span was ever created.

  // ... other simple routes, all returning early ...

  if (url.pathname === '/v1/agent') {         // ← line 58
    return tracer.startActiveSpan(...)        // ← line 70: the ONLY place
  }                                           //   a span gets created
});
```

The health check is answered at line 40 and returns. Tracing lives at line 70. For a
health check, **execution never reaches line 70** — no span object, no trace ID, no
network call, nothing stored, nothing billed.

The ordering is the entire mechanism.

> **In the hotline:** you have a notepad on your desk. A real customer call → pick up the
> pen and write an entry. The automatic line-test ring → answer it, hang up, **don't
> touch the pen.**

### The bigger cousin: sampling

Exclusion and sampling get talked about together, but they solve **different problems**:

| | What it does | How the decision is made | Used for |
|---|---|---|---|
| **Exclusion** (what we did) | never trace this route, ever | hardcoded by path | health checks, static files, metrics scrapes |
| **Sampling** | trace a *fraction* of traffic | percentage or rule | real traffic that's too voluminous |

**Exclusion** says *"this route is never interesting."*
**Sampling** says *"this traffic IS interesting, but there's too much of it."*

This project only needs exclusion — we don't have the volume for sampling to matter. But
at scale a service handling 10,000 requests a second would generate more telemetry than
actual work, so you'd keep perhaps 100% of errors and slow requests and 1% of normal ones.

Two things worth knowing about sampling when you get there:

- **The keep/drop decision must be made once, at the start, and inherited by every child
  span.** Otherwise you keep *half a trace* — three legs of a call and not the other two —
  which is worse than keeping none, because it looks complete and isn't.
- **For LLM apps, sampling by count is a trap.** Cost per request varies enormously, so a
  random 1% will usually miss your expensive outliers — the exact traces you needed. Keep
  100% of high-cost traces regardless of the sample rate.

---

## Part A summary

| The call log | Real name | Why it matters |
|---|---|---|
| Record of one customer call | trace | the whole story of one request |
| One leg of the journey | span | one model call, one tool run |
| Legs nested inside legs | parent/child spans | shows what caused what |
| 200 OK but the answer is garbage | quality has no status code | normal monitoring is blind here |
| Which cabinet trips happened | `tools_used` | catches right-answer-wrong-process |
| Cost per call, per user | cost attribution | the metric that scales with usage |
| Paying for invisible thinking | reasoning tokens | ~72% of output spend in our test |
| The log contains card numbers | redaction / capture modes | a data decision, not a debug flag |
| Receipt number | trace ID | turns "it broke" into "here's the exact run" |
| Don't log the doorbell | sampling | health checks would drown real traces |

---
---

# PART B — The professional vocabulary

## 1. Traces, spans, and why nesting is automatic

A **span** = one unit of work with a start, end, attributes, and status.
A **trace** = a tree of spans sharing a trace ID.

`tracer.startActiveSpan()` puts the span on the **async context**, so any span created
inside it becomes a child automatically. That's how `invoke_agent → chat → execute_tool`
nests without threading a parent variable through every function signature.

`SpanKind` matters: `SERVER` = someone called us, `CLIENT` = we called out. Backends use
that to draw service maps.

## 2. Why OpenTelemetry rather than a vendor SDK

Vendor-neutral. Instrument once, ship the same spans to Jaeger, Tempo, Datadog,
Honeycomb or Langfuse by changing an endpoint. Instrumenting with a proprietary SDK is
how teams end up unable to leave a vendor.

### API vs SDK — two packages, and why

**OTel** is OpenTelemetry; the **SDK** is the library that actually does the work. They
ship separately on purpose:

```
@opentelemetry/api        the light switch on the wall
@opentelemetry/sdk-node   the wiring and the electricity behind it
```

- **The API** is only the interface — `trace.getTracer()`, `span.setAttribute()`,
  `span.end()`. On its own it **does nothing**. Every call is a no-op.
- **The SDK** is what makes those calls mean something.

Flip a switch with no wiring behind it and it still clicks; it just doesn't light
anything. **That is precisely what an all-zero trace ID is** — with `OTEL_ENABLED=false`
your code still calls `startActiveSpan`, nothing errors, and every span is hollow.

What the SDK does, all of it in `src/tracing.js`:

| Job | In the code |
|---|---|
| Makes spans real instead of no-ops | `sdk.start()` |
| Stamps who is emitting them | `resourceFromAttributes({ service.name })` |
| Batches them in memory | built into `NodeSDK` |
| Ships them over the network | `OTLPTraceExporter` → `:4318` |
| Flushes on shutdown | `sdk.shutdown()` on SIGTERM/SIGINT |

**Why the split matters.** Say you publish a database library and want it instrumented.
You depend on the **API only**. Then:

- Users with no SDK configured pay **nothing** — no-ops throughout, no forced dependency,
  no data leaving their process.
- Users who *have* an SDK get your spans automatically nested inside *their* traces and
  exported wherever *they* chose.

**Library authors depend on the API; application authors install the SDK.** The single
decision — where telemetry goes — is made once by the application, not by every library
it happens to pull in.

This is also why `import './tracing.js'` must be the first line of `server.js`: the SDK
has to be running before any module grabs a tracer, or that module captures the no-op
version permanently.

## 3. Semantic conventions ⚠️

Use the standard attribute names — `gen_ai.usage.input_tokens`, not `tokens_used`. They
are what make a dashboard portable across services and readable by tools you haven't
adopted yet.

**A wrinkle we hit:** `@opentelemetry/semantic-conventions` marks its `ATTR_GEN_AI_*`
constants deprecated because GenAI conventions are moving to a dedicated package —
which isn't on npm yet. So the constants are deprecated and the replacement doesn't
exist.

Resolution worth internalising: **the attribute string is the contract, not the JS
constant.** `gen_ai.usage.input_tokens` is what goes on the wire. The constant is a
typo-guard. Pinning the strings yourself during a convention migration is correct.

## 4. Span naming: low cardinality

Span names are **categories you group by**. Never put a user ID, request ID, or prompt in
a span name — those are attributes. The convention is `{operation} {model}`, e.g.
`chat openai/gpt-oss-120b`. Unique span names make aggregation impossible and get you
throttled by most backends.

## 5. Three ways to lose your telemetry

1. **Import order.** `import './tracing.js'` must run before any module calls
   `trace.getTracer()`, or that module captures a no-op tracer at import time and
   silently emits nothing. "Tracing works everywhere except one file" is always this.
2. **No graceful shutdown.** Spans are batched and flushed periodically. A process that
   exits without `sdk.shutdown()` takes the un-flushed batch with it — so the traces
   from just before a crash, the ones you actually need, are always missing.
3. **Never ending a span.** An unended span is never exported. The trace shows a gap
   exactly where your slow operation was.

**Diagnostic:** an all-zero trace ID (`00000000000000000000000000000000`) means the SDK
never started and every span is a no-op.

## 6. Cost mechanics

```
cost = (input_tokens × input_rate) + (output_tokens × output_rate)
```

Output rates are typically several times input rates. Consequences:

- "Be concise" in a system prompt is a cost control.
- Retrieval (large input, small output) is cheaper per token than it feels.
- **Reasoning tokens** are billed as output and never appear in the response. Record
  them separately — 72% of our output spend in one project-02 call.
- Flag estimated costs. An unknown model silently priced at a default rate is how a
  cost dashboard drifts away from the actual invoice.

Attribute cost to `enduser.id` and to an operation name, not just to "the LLM."

## 7. Content capture and redaction

Three modes: `full` / `redacted` / `none`. Default to `redacted`, use `full` locally,
use `none` for regulated data.

Truncate captured content (~4 KB here). A span carrying a 100 KB prompt gets dropped by
collectors with size limits — and you lose the entire trace, not just the big attribute.

Redaction order is most-specific-first. Regex PII detection is best-effort and should
never be described as a compliance control.

## 8. What to record on an agent run

On the **root** span, so you can sort by "most expensive conversation":
`iterations`, `total_tokens`, `cost_usd`, `tools_used`, `halted_reason`.

On each **tool** span: a `gen_ai.tool.outcome` of `ok` / `validation_failed` /
`hallucinated_name` / `unparseable_arguments` / `approval_required` / `threw`. Those are
specific, searchable, alertable failure modes — "the model is inventing tool names" is a
thing you want a graph of.

## 9. Traces vs metrics

Traces answer *"what happened in this request"*. Aggregates answer *"what is this costing
me across all requests"*. Different questions, and in production different systems —
traces in Jaeger/Tempo, aggregates in Prometheus or a warehouse.

The in-process ledger here is the second one, deliberately kept independent of Jaeger so
measurement works with no Docker running at all.

---

## Experiments to actually run

```bash
npm run dev --workspace=03-observability       # http://localhost:8789
```

Works immediately with **no Docker** — the ledger is always on. For the trace waterfall:

```bash
# 1. Start Docker Desktop, then:
npm run jaeger:up --workspace=03-observability
# 2. Set OTEL_ENABLED=true in .env, restart the server
# 3. Ask something, click "open in Jaeger →"
npm run jaeger:down --workspace=03-observability   # when finished
```

| Try | What it shows |
|---|---|
| `Where is my order A-1001, and how many days until it arrives?` | 3 model calls + 2 tools nested in one trace |
| `What is the capital of France?` | 1 call — compare the cost against the above |
| `How many days until my order A-1001 arrives?` | check `tools actually used` — did it consult the clock? |
| The PII example button, with `GENAI_CAPTURE=full` vs `redacted` | the difference in the span content |
| Ask 5 things, then read the ledger | cost by model, by user, by operation |
| Set `GROQ_TOOL_MODEL=openai/gpt-oss-20b` and repeat | cheaper per call, more iterations — is it actually cheaper? |

That last one is the interesting experiment: a cheaper model that needs more round trips
is not necessarily cheaper. Only the ledger can tell you.

---

## Self-test

Questions and answer keys are in `PRACTICE.md` (gitignored — personal practice).

Topics: why LLM failures don't raise errors, traces vs spans vs metrics, semantic
conventions and why the strings matter, span cardinality, the three ways to lose
telemetry, cost mechanics and reasoning tokens, redaction modes and ordering, and what
belongs on a root span.

---

## What carries into project 04

You can now see cost per request and per user. The obvious next question is how to make
it smaller: caching answers you've already paid for, capping spend per user, and routing
easy questions to cheap models. That's project 04 — and it's built on Redis, which you
already know.
