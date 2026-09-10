import { z } from 'zod';
import { chat } from './llm.js';

/**
 * STRUCTURED OUTPUT — turning prose into data your code can branch on.
 *
 * This is the hinge that turns a chatbot into a backend component. "Write me a nice
 * reply" is a demo. "Read this email and tell me priority=high, category=billing,
 * orderId=A-1001" is something you can put in a queue, route, index, or alert on.
 *
 * The whole discipline is one sentence:
 *
 *   THE MODEL'S OUTPUT IS A STRING UNTIL YOU HAVE VALIDATED IT.
 *
 * Not "usually JSON". Not "JSON because I asked nicely". A string, from a system that
 * predicts plausible text, which is now the input to your business logic.
 */

/**
 * The contract. This is simultaneously:
 *   - runtime validation (does the reply actually match?)
 *   - documentation for the model (we render it into the prompt)
 *   - a spec for downstream code (what fields are guaranteed to exist?)
 */
export const TicketSchema = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  category: z.enum(['billing', 'shipping', 'technical', 'returns', 'other']),
  // Caps matter. Without a limit the model will happily write you a paragraph in a
  // field your UI has 60px for.
  summary: z.string().min(5).max(200),
  sentiment: z.enum(['angry', 'frustrated', 'neutral', 'happy']),
  // `.nullable()` not `.optional()` — see the note in the prompt below.
  orderId: z.string().regex(/^A-\d{4}$/).nullable(),
  requiresHumanReview: z.boolean(),
});

const SYSTEM_PROMPT = `You extract structured data from customer support emails.

Return ONLY a JSON object with exactly these fields:
  priority              "low" | "normal" | "high" | "urgent"
  category              "billing" | "shipping" | "technical" | "returns" | "other"
  summary               one sentence, max 200 characters
  sentiment             "angry" | "frustrated" | "neutral" | "happy"
  orderId               the order ID like "A-1001", or null if none is mentioned
  requiresHumanReview   true if this needs a human (threats, legal, large refunds)

Rules:
- Use null for orderId when absent. Never invent an order ID.
- Do not add fields. Do not wrap the JSON in markdown fences or commentary.`;
// ^ That last line is not paranoia. Models are trained on huge amounts of markdown, so
//   ```json fences are their most natural way to present JSON. We strip them anyway
//   below, because a prompt instruction is a request, not a guarantee.

/**
 * Models emit JSON wrapped in all sorts of packaging. Strip the common cases.
 *
 * This function is a symptom of the real lesson: prompt instructions are best-effort.
 * You still write the defensive code. Belt AND braces.
 */
function extractJsonPayload(text) {
  let s = text.trim();

  // ```json ... ``` or ``` ... ```
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();

  // Preamble like "Sure! Here's the JSON:" before the object.
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace > 0 || (lastBrace !== -1 && lastBrace < s.length - 1)) {
    if (firstBrace !== -1 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  }

  return s;
}

/**
 * Extract a ticket, validating and repairing until it conforms.
 *
 * THE REPAIR LOOP is the piece most people miss. When validation fails, you don't throw
 * — you hand the model its own broken output plus the exact validation errors and ask
 * it to fix them. Models are genuinely good at this: they usually fail on a detail
 * (an out-of-range enum, a string where a number belongs), and naming the detail is
 * enough. It converts most hard failures into one extra call.
 *
 * @returns {Promise<{ ticket: object, attempts: number, trace: Array }>}
 */
export async function extractTicket({ email, provider, maxAttempts = 3, signal }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: email },
  ];

  const trace = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { message, usage } = await chat({
      provider,
      messages,
      // JSON MODE. The provider constrains decoding so the output is syntactically
      // valid JSON. This eliminates ONE class of failure — malformed syntax.
      //
      // It does NOT guarantee your shape. The model can return perfectly valid JSON
      // with a missing field, an invented field, or priority: "very high". That's why
      // json mode does not replace validation — it just means you fail at the schema
      // check rather than at JSON.parse.
      responseFormat: { type: 'json_object' },
      signal,
    });

    const raw = message.content ?? '';
    let parsed;

    try {
      parsed = JSON.parse(extractJsonPayload(raw));
    } catch (err) {
      trace.push({ attempt, stage: 'parse', ok: false, error: err.message, raw, usage });
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `That was not valid JSON (${err.message}). Return only the JSON object.`,
      });
      continue;
    }

    const result = TicketSchema.safeParse(parsed);
    if (result.success) {
      trace.push({ attempt, stage: 'validate', ok: true, usage });
      return { ticket: result.data, attempts: attempt, trace };
    }

    // Turn Zod's error tree into short, specific instructions. Precision matters here:
    // "invalid input" gets you another guess, while "priority: expected one of
    // low|normal|high|urgent, received 'very high'" usually gets you a fix.
    const problems = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');

    trace.push({ attempt, stage: 'validate', ok: false, problems, raw, usage });

    // Feed back the model's OWN output plus the errors. Keeping its previous answer in
    // the conversation is what lets it patch rather than start over from scratch.
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `That JSON did not match the required schema:\n${problems}\n\nReturn the corrected JSON object only.`,
    });
  }

  // Bounded, and it fails loudly. An unbounded repair loop against a model that is
  // confidently wrong will retry forever and bill you for every attempt.
  const err = new Error(`Could not get schema-valid output after ${maxAttempts} attempts`);
  err.trace = trace;
  throw err;
}
