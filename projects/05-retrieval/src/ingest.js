import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pool, initSchema, findByChecksum } from './db.js';
import { extractPages, assessExtraction, detectRepeatedLines, stripRepeatedLines } from './pdf.js';
import { chunkPages, chunkDefaults } from './chunk.js';
import { embedBatch, toPgVector } from './embeddings.js';

/**
 * THE INGESTION PIPELINE
 *
 *   PDF file
 *     │
 *     ├─ 1. extract text, page by page          pdf.js        ← the ugly part
 *     ├─ 2. check it's not a scan               assess        ← fail loudly, not silently
 *     ├─ 3. strip running headers/footers       detect        ← stop polluting every chunk
 *     ├─ 4. split into overlapping chunks       chunk.js      ← where quality is decided
 *     ├─ 5. embed them all, in batches          local model   ← the slow step
 *     └─ 6. insert with page numbers            Postgres      ← page = citation
 *
 * Run it:  npm run ingest --workspace=05-retrieval -- docs/acme-handbook.pdf
 *          npm run ingest --workspace=05-retrieval            (all PDFs in docs/)
 */

export async function ingestFile(filePath, { onProgress } = {}) {
  const log = (msg) => onProgress?.(msg) ?? console.log(msg);
  const startedAt = Date.now();

  // ── 1. Extract ──────────────────────────────────────────────────────────────
  log(`▸ reading ${basename(filePath)}`);
  const { pages, checksum, meta } = await extractPages(filePath);

  // Skip work we've already done. Without this, re-running ingestion silently
  // DOUBLES every chunk — and duplicates crowd out genuinely different passages,
  // quietly degrading retrieval in a way that's hard to notice.
  const existing = await findByChecksum(checksum);
  if (existing) {
    log(`  already ingested as "${existing.filename}" (${existing.chunk_count} chunks) — skipping`);
    return { skipped: true, document: existing };
  }

  // ── 2. Is this actually readable? ───────────────────────────────────────────
  const assessment = assessExtraction(pages);
  log(`  ${pages.length} pages, ${assessment.totalChars.toLocaleString()} chars (~${assessment.charsPerPage}/page)`);

  if (!assessment.ok) {
    // Refuse rather than build an index over nothing.
    const err = new Error(assessment.problems.join(' '));
    err.assessment = assessment;
    throw err;
  }

  // ── 3. Strip running headers and footers ────────────────────────────────────
  const repeated = detectRepeatedLines(pages);
  const cleanedPages = repeated.size ? pages.map((p) => stripRepeatedLines(p, repeated)) : pages;
  if (repeated.size) {
    log(`  stripped ${repeated.size} repeated header/footer line(s) from every page`);
  }

  // ── 4. Chunk ────────────────────────────────────────────────────────────────
  const chunks = chunkPages(cleanedPages);
  const avgSize = Math.round(chunks.reduce((n, c) => n + c.text.length, 0) / (chunks.length || 1));
  log(`  ${chunks.length} chunks (target ${chunkDefaults.targetSize} chars, overlap ${chunkDefaults.overlap}, actual avg ${avgSize})`);

  if (chunks.length === 0) throw new Error('No chunks produced — the document appears to be empty.');

  // ── 5. Embed ────────────────────────────────────────────────────────────────
  log(`  embedding ${chunks.length} chunks…`);
  const embedStart = Date.now();
  const vectors = await embedBatch(
    chunks.map((c) => c.text),
    (done, total) => {
      if (done % 128 === 0 || done === total) log(`    ${done}/${total}`);
    },
  );
  log(`  embedded in ${((Date.now() - embedStart) / 1000).toFixed(1)}s`);

  // ── 6. Insert ───────────────────────────────────────────────────────────────
  // One transaction for the document and all its chunks. If anything fails halfway,
  // you get nothing rather than a half-ingested document that retrieves partial
  // answers — which would be worse than an obvious failure.
  const client = await pool.connect();
  const documentId = randomUUID();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO documents (id, filename, title, checksum, page_count, chunk_count)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [documentId, basename(filePath), meta.title, checksum, pages.length, chunks.length],
    );

    // Insert in batches. One INSERT per chunk means one round trip per chunk — the
    // same N+1 mistake as project 04's unpipelined Redis loop, and just as costly.
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const values = [];
      const params = [];

      slice.forEach((chunk, j) => {
        const base = j * 6;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
        params.push(
          documentId,
          chunk.page,
          chunk.chunkIndex,
          chunk.text,
          chunk.tokenEstimate,
          toPgVector(vectors[i + j]),
        );
      });

      await client.query(
        `INSERT INTO chunks (document_id, page, chunk_index, text, token_estimate, embedding)
         VALUES ${values.join(',')}`,
        params,
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`✓ ingested in ${seconds}s — ${chunks.length} chunks across ${pages.length} pages`);

  return {
    skipped: false,
    document: {
      id: documentId,
      filename: basename(filePath),
      title: meta.title,
      page_count: pages.length,
      chunk_count: chunks.length,
    },
    assessment,
    seconds: Number(seconds),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
//
// "Was this file run directly, or imported by something else?"
//
// The naive version — building the URL by hand from process.argv[1] — breaks on
// Windows, where argv[1] is `C:\path\file.js` and import.meta.url is
// `file:///C:/path/file.js`. Three slashes and a drive letter. `pathToFileURL` does
// the platform-specific conversion correctly, so this works everywhere.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const docsDir = fileURLToPath(new URL('../docs/', import.meta.url));
  const args = process.argv.slice(2);

  await initSchema();

  let files = args;
  if (files.length === 0) {
    const entries = await readdir(docsDir).catch(() => []);
    files = entries.filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => docsDir + f);
    if (files.length === 0) {
      console.error(
        `No PDFs found in ${docsDir}\n` +
          `  Drop one in, or generate the sample:  node scripts/make-sample-pdf.js`,
      );
      process.exit(1);
    }
    console.log(`▸ found ${files.length} PDF(s) in docs/`);
  }

  for (const file of files) {
    try {
      await ingestFile(file);
    } catch (err) {
      console.error(`✗ ${basename(file)}: ${err.message}`);
    }
  }

  await pool.end();
}
