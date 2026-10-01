/**
 * CHUNKING — splitting a document into retrievable pieces.
 *
 * ⚠️ This matters MORE than your choice of vector database, and gets a fraction of the
 * attention. You can swap Postgres for Qdrant and barely move the needle. Change your
 * chunk size and retrieval quality moves enormously.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CHUNK AT ALL?
 *
 * Because one embedding is one point on the map of meaning. Embed a whole 500-word
 * page and you get the *average* of everything on it — a point in the middle of
 * nowhere, close to nothing in particular. Ask about annual leave and a page covering
 * leave, expenses and parking won't match well, because only a third of it is about
 * leave.
 *
 * Smaller pieces = sharper points on the map.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SIZE TRADE-OFF — both directions hurt
 *
 *   TOO SMALL                              TOO BIG
 *   "receives 22 days of annual leave"     a whole page about everything
 *          ▲                                      ▲
 *   22 days of WHAT GRADE?                 the embedding averages out to mush,
 *   The chunk retrieves perfectly and      retrieval gets vague, and you burn
 *   answers nothing.                       input tokens on irrelevant text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY OVERLAP
 *
 * A fact doesn't care where your boundary is:
 *
 *   chunk 1: "... Annual leave entitlement depends on employment grade."
 *   chunk 2: "A grade 5 employee receives 22 days ..."
 *                     ↑
 *   Split there and neither chunk answers "how much leave for grade 5" well — the
 *   first has the question, the second has a number with no context.
 *
 * Overlapping by a sentence or two means the boundary falls in two places at once, so
 * at least one chunk holds the whole fact. You pay for it in storage and duplicate
 * retrieval, which is why the overlap is small.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPLIT ON STRUCTURE, NOT ON CHARACTER COUNT
 *
 * The naive version — `text.slice(i, i + 500)` — cuts mid-word and mid-sentence,
 * producing fragments that embed badly and read worse when shown as a citation.
 *
 * So we split RECURSIVELY, preferring the most natural boundary available:
 *
 *      paragraph  →  line  →  sentence  →  word  →  (last resort) character
 */

const DEFAULTS = {
  // Characters, not tokens — a rough proxy, but one you can reason about directly.
  // ~500 chars ≈ 125 tokens ≈ a decent paragraph.
  targetSize: Number(process.env.CHUNK_SIZE ?? 500),
  overlap: Number(process.env.CHUNK_OVERLAP ?? 100),
  // Below this, a chunk is a fragment with no standalone meaning. Merge it into its
  // neighbour instead of indexing noise.
  minSize: 80,
};

/** Separators in order of preference — most semantically meaningful first. */
const SEPARATORS = [
  '\n\n', // paragraph
  '\n', // line
  '. ', // sentence
  '? ',
  '! ',
  '; ',
  ', ',
  ' ', // word
  '', // character — only if a single "word" is longer than the target
];

/**
 * Split one string into pieces no larger than `targetSize`, breaking at the most
 * natural separator that works.
 */
function recursiveSplit(text, targetSize, separators = SEPARATORS) {
  if (text.length <= targetSize) return [text];

  const [separator, ...rest] = separators;

  // Last resort: no separator left, so cut on character count.
  if (separator === '' || separators.length === 0) {
    const out = [];
    for (let i = 0; i < text.length; i += targetSize) out.push(text.slice(i, i + targetSize));
    return out;
  }

  const parts = text.split(separator);
  // This separator doesn't appear — try the next one down.
  if (parts.length === 1) return recursiveSplit(text, targetSize, rest);

  // Greedily pack parts together until adding the next would overflow.
  const chunks = [];
  let current = '';

  for (const part of parts) {
    const candidate = current ? current + separator + part : part;

    if (candidate.length <= targetSize) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    // A single part bigger than the target? Split it further with finer separators.
    if (part.length > targetSize) {
      chunks.push(...recursiveSplit(part, targetSize, rest));
      current = '';
    } else {
      current = part;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Add overlap by prepending the tail of the previous chunk.
 *
 * We take whole sentences where we can, so the overlap reads naturally when shown to
 * a user as a citation — a citation starting mid-word looks broken even when the
 * retrieval was perfect.
 */
function addOverlap(chunks, overlapChars) {
  if (overlapChars <= 0 || chunks.length < 2) return chunks;

  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;

    const prev = chunks[i - 1];
    let tail = prev.slice(-overlapChars);

    // Trim forward to the next sentence or word boundary so we don't start mid-word.
    const sentenceStart = tail.search(/[.!?]\s+/);
    if (sentenceStart !== -1 && sentenceStart < tail.length - 2) {
      tail = tail.slice(sentenceStart + 1).trimStart();
    } else {
      const space = tail.indexOf(' ');
      if (space !== -1) tail = tail.slice(space + 1);
    }

    return tail ? `${tail.trim()} ${chunk}` : chunk;
  });
}

/**
 * Merge chunks that ended up too small to stand alone.
 *
 * Section headings are the classic case: "SECTION 2: ANNUAL LEAVE" is its own
 * paragraph, ~24 characters, and on its own it is a useless retrieval result. Glued to
 * the text beneath it, it's a *better* chunk than the text alone — the heading tells
 * the embedding what the passage is about.
 */
function mergeTinyChunks(chunks, minSize) {
  const out = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (chunk.length < minSize && prev) {
      out[out.length - 1] = `${prev}\n${chunk}`;
    } else {
      out.push(chunk);
    }
  }
  // A heading at the very start has no previous chunk — fold it forward instead.
  if (out.length > 1 && out[0].length < minSize) {
    out[1] = `${out[0]}\n${out[1]}`;
    out.shift();
  }
  return out;
}

/**
 * Chunk a whole document, page by page.
 *
 * WHY PER PAGE, not across the whole document: so every chunk knows which page it came
 * from. That page number is what makes a citation possible — and a citation is what
 * turns "trust me" into "check page 2 yourself".
 *
 * The cost is honest: a passage spanning a page break gets split there whether we like
 * it or not. For most documents that's an acceptable trade for being able to cite.
 *
 * @param {string[]} pages
 * @returns {Array<{page:number, chunkIndex:number, text:string, tokenEstimate:number}>}
 */
export function chunkPages(pages, options = {}) {
  const { targetSize, overlap, minSize } = { ...DEFAULTS, ...options };
  const result = [];
  let globalIndex = 0;

  pages.forEach((pageText, pageIndex) => {
    const trimmed = pageText?.trim();
    if (!trimmed) return;

    let pieces = recursiveSplit(trimmed, targetSize);
    pieces = mergeTinyChunks(pieces, minSize);
    pieces = addOverlap(pieces, overlap);

    for (const text of pieces) {
      const clean = text.trim();
      if (clean.length < 20) continue; // pure noise
      result.push({
        page: pageIndex + 1, // pages are 1-indexed for humans
        chunkIndex: globalIndex++,
        text: clean,
        // ~4 characters per token is the usual rule of thumb for English.
        tokenEstimate: Math.ceil(clean.length / 4),
      });
    }
  });

  return result;
}

export const chunkDefaults = DEFAULTS;
