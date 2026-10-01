import pg from 'pg';

/**
 * Postgres + pgvector.
 *
 * THE SCHEMA IS THE DESIGN. Two tables and two indexes, and almost every retrieval
 * decision is visible in them:
 *
 *   - `embedding vector(384)`  → similarity search  (what does this MEAN?)
 *   - `tsv tsvector`           → keyword search     (does it contain this EXACT term?)
 *   - `page`                   → citations          (how a claim gets traced back)
 *   - `checksum`               → don't re-ingest the same file twice
 *
 * You need both kinds of search. Vectors are bad at exact tokens — ask about
 * "SEC-0001" or "section 4.2" and an embedding will cheerfully return section 4.1,
 * because those two genuinely mean almost the same thing. Keyword search has the
 * opposite problem: it can't match "holiday pay" to "annual leave entitlement".
 */

const { Pool } = pg;

const CONNECTION =
  process.env.PG_URL ?? 'postgresql://rag:rag@localhost:5433/rag';

export const pool = new Pool({
  connectionString: CONNECTION,
  // Small pool: this is a single-user learning app, and an idle connection still
  // costs Postgres a process.
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

/**
 * Create everything if it doesn't exist. Safe to run on every boot.
 */
export async function initSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id          uuid PRIMARY KEY,
      filename    text NOT NULL,
      title       text,
      -- A hash of the file's bytes. Ingest the same PDF twice and we can skip it
      -- rather than silently doubling every chunk — which would quietly wreck
      -- retrieval, because duplicates crowd out genuinely different passages.
      checksum    text UNIQUE NOT NULL,
      page_count  int,
      chunk_count int,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           bigserial PRIMARY KEY,
      document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      -- The page this text came from. This single column is what makes citations
      -- possible, and citations are what make "nothing outside the document"
      -- verifiable rather than merely requested.
      page         int NOT NULL,
      chunk_index  int NOT NULL,
      text         text NOT NULL,
      token_estimate int,
      embedding    vector(384),
      -- GENERATED ALWAYS means Postgres maintains this itself on every insert and
      -- update. One less thing to forget, and it can never drift from the text.
      tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
    );
  `);

  // ── The two indexes, one per kind of search ──────────────────────────────────

  // HNSW — the layered shortcut map from project 04's notes, now real. Finds
  // approximate nearest neighbours in ~O(log n) instead of comparing everything.
  //
  // `vector_cosine_ops` must match the distance operator used at query time (`<=>`).
  // Build the index for cosine and query with L2 and you get silently wrong ordering.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx
      ON chunks USING hnsw (embedding vector_cosine_ops);
  `);

  // GIN — the inverted index behind keyword search. Maps each word to the rows
  // containing it, which is exactly what a search engine needs.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
  `);
}

export async function listDocuments() {
  const { rows } = await pool.query(`
    SELECT id, filename, title, page_count, chunk_count, created_at
    FROM documents ORDER BY created_at DESC
  `);
  return rows;
}

export async function findByChecksum(checksum) {
  const { rows } = await pool.query(`SELECT * FROM documents WHERE checksum = $1`, [checksum]);
  return rows[0] ?? null;
}

export async function deleteDocument(id) {
  // ON DELETE CASCADE on chunks.document_id means the chunks go too — no orphans,
  // enforced by the database rather than by remembering.
  const { rowCount } = await pool.query(`DELETE FROM documents WHERE id = $1`, [id]);
  return rowCount;
}

export async function stats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM documents) AS documents,
      (SELECT count(*) FROM chunks)    AS chunks,
      (SELECT count(*) FROM chunks WHERE embedding IS NULL) AS unembedded
  `);
  return rows[0];
}

export async function close() {
  await pool.end();
}
