import { pipeline } from '@huggingface/transformers';

/**
 * Embeddings — same model and same idea as project 04, with one addition that matters
 * here: BATCHING.
 *
 * In project 04 you embedded one question at a time. Here you embed every chunk of a
 * document — hundreds or thousands of them. Calling the model once per chunk wastes
 * most of the work, because the model can process many texts in one pass far more
 * efficiently than one at a time.
 *
 * THIS IS WHY LOCAL EMBEDDINGS WERE THE RIGHT CALL. A 300-page book is ~2,000 chunks.
 * On a rate-limited free API tier you would stall partway through your first
 * ingestion. Locally it's unlimited, free, and takes a couple of minutes once.
 */

const MODEL = process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
export const DIMENSIONS = 384;

// How many texts to hand the model at once. Bigger is faster per text but uses more
// memory — on an 8 GB machine, 32 is a safe default.
const BATCH_SIZE = Number(process.env.EMBED_BATCH ?? 32);

let embedderPromise = null;

function getEmbedder() {
  embedderPromise ??= pipeline('feature-extraction', MODEL, { dtype: 'q8' }).then((p) => {
    console.log(`▸ embedding model ready: ${MODEL} (${DIMENSIONS} dims)`);
    return p;
  });
  return embedderPromise;
}

export const warmUp = () => getEmbedder();

/** Embed a single string — used for queries. */
export async function embed(text) {
  const embedder = await getEmbedder();
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/**
 * Embed many texts, in batches, reporting progress.
 *
 * @param {string[]} texts
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, onProgress) {
  const embedder = await getEmbedder();
  const vectors = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const out = await embedder(batch, { pooling: 'mean', normalize: true });

    // The model returns one flat Float32Array containing every vector end to end.
    // Slice it back apart by dimension count.
    for (let j = 0; j < batch.length; j++) {
      vectors.push(Array.from(out.data.slice(j * DIMENSIONS, (j + 1) * DIMENSIONS)));
    }

    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }

  return vectors;
}

/**
 * Format a vector the way pgvector expects it in SQL: '[0.1,0.2,...]'.
 *
 * pgvector accepts a string literal in this exact shape. Hand it a JS array via the
 * `pg` driver and you get a Postgres array, which is a different type and fails.
 */
export const toPgVector = (vec) => `[${vec.join(',')}]`;

/**
 * Cosine similarity, for when we compare vectors in JavaScript rather than in SQL.
 * Both vectors are already normalised, so the dot product IS the cosine.
 */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
