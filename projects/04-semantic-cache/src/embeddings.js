import { pipeline } from '@huggingface/transformers';

/**
 * EMBEDDINGS — turning text into coordinates on a map of meaning.
 *
 * An embedding is a list of numbers (384 of them here) that positions a piece of text
 * in space. Text that means similar things lands in similar places. That's the whole
 * idea, and everything else in this project and the next is arithmetic on top of it.
 *
 * WHY LOCAL, NOT AN API:
 * Embedding models are tiny — this one is about 25 MB, versus tens of gigabytes for a
 * chat model. It runs on CPU in ~18ms per sentence.
 *
 * That matters most in project 05: embedding a 300-page book is thousands of calls.
 * On a free API tier you'd hit the rate limit partway through your first ingestion and
 * be stuck. Locally it's unlimited and free — you wait two minutes, once.
 *
 * The model downloads on first use and is cached on disk afterwards.
 */

const MODEL = process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';

let embedderPromise = null;

/**
 * Load the model once, lazily, and share it.
 *
 * Loading takes ~5 seconds. Doing it per request would be catastrophic, and doing it
 * at import time would make the server slow to start even when nothing needs it.
 * A memoised promise gives you both: first caller pays, everyone else waits on the
 * same load rather than starting a second one.
 */
function getEmbedder() {
  embedderPromise ??= pipeline('feature-extraction', MODEL, {
    // q8 = 8-bit quantised. Roughly a quarter the size and faster, for a small
    // accuracy cost that does not matter at all for "are these two questions
    // similar" — but would matter if you were ranking thousands of near-identical
    // documents.
    dtype: 'q8',
  }).then((p) => {
    console.log(`▸ embedding model ready: ${MODEL} (384 dims)`);
    return p;
  });
  return embedderPromise;
}

/** Warm the model at startup so the first real request isn't 5 seconds slow. */
export const warmUp = () => getEmbedder();

/**
 * Turn text into a 384-number vector.
 *
 * `pooling: 'mean'` — the model produces one vector per token; we average them into
 * a single vector for the whole sentence.
 *
 * `normalize: true` — scales the vector to length 1. This is what lets us use a plain
 * dot product as cosine similarity below, which is meaningfully faster.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Cosine similarity: how close are two pieces of text in meaning?
 *
 * Returns roughly 0 (unrelated) to 1 (identical). Because both vectors are already
 * normalised to length 1, the cosine is just the dot product — no division needed.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE NUMBER.
 *
 * Measured with this exact model:
 *
 *   0.508   "What is your return policy?"  vs  "How do I return an item?"     SAFE
 *   0.938   "What is the capital of France?" vs "Which city is France's capital?"  SAFE
 *   0.962   "Where is my order A-1001?"    vs  "Where is my order A-1002?"    DANGER
 *   0.839   "Can I cancel my order?"       vs  "Did I cancel my order?"       DANGER
 *
 * The pairs that MEAN the same thing score LOW. The pairs that need completely
 * DIFFERENT answers score HIGH. Embeddings measure surface similarity far more than
 * intent, and "A-1001" versus "A-1002" is a one-character difference.
 *
 * So the safe and dangerous ranges overlap, and **no threshold separates them**.
 * Similarity is necessary but never sufficient — see the guards in cache.js.
 */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
