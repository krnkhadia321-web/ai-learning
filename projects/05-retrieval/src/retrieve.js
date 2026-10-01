import { pool } from './db.js';
import { embed, toPgVector } from './embeddings.js';

/**
 * HYBRID RETRIEVAL — two searches, fused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TWO SEARCHES
 *
 * They fail in opposite directions, and each covers the other's blind spot.
 *
 *   VECTOR SEARCH          finds things that MEAN the same
 *     ✅ "holiday allowance"  →  finds "annual leave entitlement"
 *     ❌ "SEC-0001"           →  happily returns SEC-0042; to an embedding those
 *                                 two strings mean almost exactly the same thing
 *
 *   KEYWORD SEARCH         finds things that CONTAIN the term
 *     ✅ "SEC-0001"           →  exact match, no ambiguity
 *     ❌ "holiday allowance"  →  nothing; the document never uses those words
 *
 * Any real document needs both. Identifiers, product codes, section numbers, names
 * and error codes are exactly the things users search for and exactly the things
 * embeddings are worst at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ HOW TO COMBINE THEM: fuse by RANK, not by score
 *
 * The obvious approach — add the two scores together — does not work, because they
 * are on completely unrelated scales:
 *
 *     cosine distance   0.0 → 2.0     (lower is better)
 *     ts_rank           0.0 → ~1.0    (higher is better, and the distribution
 *                                      depends on document length and term rarity)
 *
 * Adding those is meaningless. Normalising them is fragile — the min and max shift
 * with every query.
 *
 * So ignore the scores and use the ORDERING, which is comparable across any two
 * rankers. That's **Reciprocal Rank Fusion**:
 *
 *     score(chunk) = Σ  1 / (k + rank_in_that_list)          k = 60 by convention
 *
 * A chunk ranked 1st by vectors and 3rd by keywords scores 1/61 + 1/63.
 * A chunk found by only one scores from that one alone.
 *
 * Why it works: appearing high in BOTH lists beats appearing top of one. The k=60
 * damps the difference between rank 1 and rank 2, so a single confident ranker can't
 * dominate — agreement between methods is what gets rewarded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RRF_K = 60;

/**
 * ⚠️ BUILDING THE KEYWORD QUERY — a trap worth knowing about.
 *
 * The obvious choice is `plainto_tsquery`, and it is WRONG for natural-language
 * questions, because it joins every term with AND:
 *
 *   plainto_tsquery('how many days of annual leave does a grade 7 employee get')
 *     →  'mani' & 'day' & 'annual' & 'leav' & 'grade' & '7' & 'employe' & 'get'
 *
 * A chunk must now contain ALL of those — including "many" and "get", which appear in
 * no handbook passage. Result: **zero rows, on every real question.** Measured: the
 * keyword half of our hybrid search silently contributed nothing at all until this
 * was fixed, and the bug is invisible because the vector half still returns results.
 *
 * What you actually want is BM25-style behaviour: match ANY term, and rank higher for
 * matching more of them, and for matching rarer ones.
 *
 * So build the query with OR instead:
 *
 *   to_tsvector     → normalises, stems, and drops stop-words ("how", "of", "does")
 *   tsvector_to_array → the surviving lexemes
 *   joined with ' | ' → an OR query
 *
 *     →  '7' | 'annual' | 'day' | 'employe' | 'get' | 'grade' | 'leav' | 'mani'
 *
 * `ts_rank` then does the work: a chunk containing "annual", "leav" and "grade" ranks
 * above one containing only "get". NULLIF guards the all-stop-words case — a NULL
 * tsquery matches nothing rather than raising a syntax error.
 */
const OR_TSQUERY = `
  to_tsquery('english',
    NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', $4)), ' | '), '')
  )`;

// How many candidates each search contributes before fusion. Wider than the final
// result count on purpose: a chunk ranked 15th by vectors and 2nd by keywords should
// still get a chance, and it can only do that if both lists are deep enough to see it.
const CANDIDATES = Number(process.env.RETRIEVE_CANDIDATES ?? 20);

/**
 * @returns {Promise<Array<{id, page, text, vectorRank, keywordRank, rrfScore, similarity}>>}
 */
export async function hybridSearch({ query, documentId, limit = 8 }) {
  const queryVector = toPgVector(await embed(query));

  const { rows } = await pool.query(
    `
    WITH
    -- ① Semantic: nearest neighbours by cosine distance, using the HNSW index.
    --    <=> is pgvector's cosine distance operator. It MUST match the operator
    --    class the index was built with (vector_cosine_ops), or Postgres silently
    --    ignores the index and the ordering is wrong.
    vector_hits AS (
      SELECT id, page, text,
             embedding <=> $1::vector        AS distance,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM chunks
      WHERE ($2::uuid IS NULL OR document_id = $2::uuid)
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    ),

    -- ② Lexical: full-text search over the generated tsvector, using the GIN index.
    --    See OR_TSQUERY above for why the query is built with OR rather than
    --    plainto_tsquery. The stemming is why "leave", "leaves" and "leaving" all
    --    match the same lexeme 'leav'.
    keyword_hits AS (
      SELECT id, page, text,
             ts_rank(tsv, q)                             AS score,
             ROW_NUMBER() OVER (ORDER BY ts_rank(tsv, q) DESC) AS rank
      FROM chunks, ${OR_TSQUERY} q
      WHERE ($2::uuid IS NULL OR document_id = $2::uuid)
        AND tsv @@ q
      ORDER BY ts_rank(tsv, q) DESC
      LIMIT $3
    )

    -- ③ Fuse. FULL OUTER JOIN because a chunk may appear in either list or both;
    --    an INNER JOIN would throw away everything only one method found, which is
    --    precisely the material the other method is blind to.
    SELECT
      COALESCE(v.id, k.id)                     AS id,
      COALESCE(v.page, k.page)                 AS page,
      COALESCE(v.text, k.text)                 AS text,
      v.rank                                   AS vector_rank,
      k.rank                                   AS keyword_rank,
      1 - v.distance                           AS similarity,
      COALESCE(1.0 / ($5 + v.rank), 0)
        + COALESCE(1.0 / ($5 + k.rank), 0)     AS rrf_score
    FROM vector_hits v
    FULL OUTER JOIN keyword_hits k ON v.id = k.id
    ORDER BY rrf_score DESC
    LIMIT $6
    `,
    [queryVector, documentId ?? null, CANDIDATES, query, RRF_K, limit],
  );

  return rows.map((r) => ({
    id: Number(r.id),
    page: r.page,
    text: r.text,
    vectorRank: r.vector_rank ? Number(r.vector_rank) : null,
    keywordRank: r.keyword_rank ? Number(r.keyword_rank) : null,
    // null when only keyword search found it — there's no distance to report.
    similarity: r.similarity === null ? null : Number(r.similarity),
    rrfScore: Number(r.rrf_score),
    // Which method surfaced this? Genuinely useful when debugging why an answer
    // was grounded in the wrong passage.
    foundBy: r.vector_rank && r.keyword_rank ? 'both' : r.vector_rank ? 'vector' : 'keyword',
  }));
}

/** Vector-only search — for comparing against hybrid in the test bench. */
export async function vectorSearch({ query, documentId, limit = 8 }) {
  const queryVector = toPgVector(await embed(query));
  const { rows } = await pool.query(
    `SELECT id, page, text, 1 - (embedding <=> $1::vector) AS similarity
     FROM chunks
     WHERE ($2::uuid IS NULL OR document_id = $2::uuid)
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [queryVector, documentId ?? null, limit],
  );
  return rows.map((r, i) => ({
    id: Number(r.id),
    page: r.page,
    text: r.text,
    similarity: Number(r.similarity),
    vectorRank: i + 1,
    keywordRank: null,
    foundBy: 'vector',
  }));
}

/** Keyword-only search — the other half of the comparison. */
export async function keywordSearch({ query, documentId, limit = 8 }) {
  const { rows } = await pool.query(
    `SELECT id, page, text, ts_rank(tsv, q) AS score
     FROM chunks, to_tsquery('english', NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | '), '')) q
     WHERE ($2::uuid IS NULL OR document_id = $2::uuid) AND tsv @@ q
     ORDER BY ts_rank(tsv, q) DESC
     LIMIT $3`,
    [query, documentId ?? null, limit],
  );
  return rows.map((r, i) => ({
    id: Number(r.id),
    page: r.page,
    text: r.text,
    similarity: null,
    keywordScore: Number(r.score),
    vectorRank: null,
    keywordRank: i + 1,
    foundBy: 'keyword',
  }));
}
