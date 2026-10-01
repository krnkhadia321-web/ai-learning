import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { pool, initSchema, listDocuments, deleteDocument, stats } from './db.js';
import { ingestFile } from './ingest.js';
import { answerQuestion, answerConfig } from './answer.js';
import { hybridSearch, vectorSearch, keywordSearch } from './retrieve.js';
import { warmUp } from './embeddings.js';
import { chunkDefaults } from './chunk.js';

const PORT = Number(process.env.PORT_05 ?? 8791);
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
};

async function readBody(req, limitBytes = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('File too large (60 MB limit)');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        db: await stats(),
        config: { ...answerConfig, chunking: chunkDefaults },
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/documents') {
      return json(res, 200, { documents: await listDocuments() });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/documents/')) {
      const id = url.pathname.split('/').pop();
      return json(res, 200, { deleted: await deleteDocument(id) });
    }

    // ── Upload ──────────────────────────────────────────────────────────────
    //
    // Raw PDF bytes in the body, filename in the query string. Deliberately NOT
    // multipart/form-data: parsing multipart by hand is fiddly and teaches nothing
    // about retrieval. The browser sends the File object straight through.
    if (req.method === 'POST' && url.pathname === '/v1/upload') {
      const filename = (url.searchParams.get('filename') ?? 'upload.pdf')
        // Never trust a client-supplied filename. Strip any path component so
        // "../../.env" can't escape the docs directory.
        .replace(/[/\\]/g, '_')
        .replace(/[^\w.\- ]/g, '');

      if (!filename.toLowerCase().endsWith('.pdf')) {
        return json(res, 400, { error: 'Only .pdf files are supported.' });
      }

      const bytes = await readBody(req);
      await mkdir(DOCS_DIR, { recursive: true });
      const path = DOCS_DIR + filename;
      await writeFile(path, bytes);

      const log = [];
      try {
        const result = await ingestFile(path, { onProgress: (m) => log.push(m) });
        return json(res, 200, { ...result, log });
      } catch (err) {
        // Extraction failures carry the assessment, which explains WHY — usually
        // "this is a scanned PDF". Pass it through rather than a bare 500.
        return json(res, 422, { error: err.message, assessment: err.assessment ?? null, log });
      }
    }

    // ── The main event: a grounded answer, or a refusal ──────────────────────
    if (req.method === 'POST' && url.pathname === '/v1/ask') {
      const { question, documentId } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!question) return json(res, 400, { error: '`question` is required' });

      const result = await answerQuestion({ question, documentId });
      console.log(
        `[ask] ${result.grounded ? 'answered' : 'REFUSED'} (${result.reason ?? 'ok'}) ` +
          `${result.latencyMs}ms $${(result.costUsd ?? 0).toFixed(7)} — "${question.slice(0, 60)}"`,
      );
      return json(res, 200, result);
    }

    // ── Retrieval comparison, no model involved ──────────────────────────────
    //
    // Separate endpoint on purpose. When an answer is wrong you need to know whether
    // retrieval failed or reasoning did — those have completely different fixes, and
    // you cannot tell them apart from the answer alone.
    if (req.method === 'POST' && url.pathname === '/v1/search') {
      const { query, documentId, limit = 5 } = JSON.parse(
        (await readBody(req)).toString('utf8') || '{}',
      );
      if (!query) return json(res, 400, { error: '`query` is required' });

      const [vector, keyword, hybrid] = await Promise.all([
        vectorSearch({ query, documentId, limit }),
        keywordSearch({ query, documentId, limit }),
        hybridSearch({ query, documentId, limit }),
      ]);
      return json(res, 200, { query, vector, keyword, hybrid });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, async () => {
  console.log(`▸ retrieval server on http://localhost:${PORT}`);

  try {
    await initSchema();
    const s = await stats();
    console.log(`▸ postgres ready — ${s.documents} document(s), ${s.chunks} chunk(s)`);
    if (Number(s.documents) === 0) {
      console.log(`  nothing ingested yet. Upload a PDF in the browser, or:`);
      console.log(`    node scripts/make-sample-pdf.js && npm run ingest --workspace=05-retrieval`);
    }
  } catch (err) {
    console.warn(
      `\n  ⚠  Postgres unreachable: ${err.message}\n` +
        `     Start it with:  npm run db:up --workspace=05-retrieval\n`,
    );
  }

  await warmUp();
  console.log(`▸ gate: refuse below similarity ${answerConfig.MIN_SIMILARITY}, top-k ${answerConfig.TOP_K}`);
});

const shutdown = async () => {
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
