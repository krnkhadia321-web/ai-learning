import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * PDF text extraction.
 *
 * ⚠️ THE UGLIEST PART OF ANY RAG SYSTEM, and nobody warns you.
 *
 * A PDF does not contain paragraphs, sentences, or even reliably words. It contains
 * instructions like "draw the glyph 'A' at coordinates (72, 410)". Text extraction is
 * the job of looking at thousands of positioned glyphs and guessing where the words,
 * lines and columns were.
 *
 * Which means these all go wrong in ways that are invisible until you inspect the output:
 *
 *   - two-column layouts read straight across, interleaving both columns
 *   - tables collapse into a soup of numbers with the structure gone
 *   - headers and footers repeat on every page, polluting every chunk
 *   - ligatures ("ﬁ") and hyphenated line-breaks split words
 *   - SCANNED PDFs contain no text at all — they're photographs
 *
 * We handle the common cases and FAIL LOUDLY on the one we can't (scanned).
 * Silently returning nothing is how you end up debugging retrieval for an hour when
 * the problem was that there was never any text.
 */

/** pdf.js ships a "legacy" build for Node; the default build expects browser APIs. */
async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

export function checksum(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extract one string of text per page.
 *
 * @returns {Promise<{pages: string[], meta: object}>}
 */
export async function extractPages(filePath) {
  const data = await readFile(filePath);
  const { getDocument } = await getPdfJs();

  const doc = await getDocument({
    // A copy, because pdf.js transfers ownership of the buffer it's given and we
    // still want the original bytes for the checksum.
    data: new Uint8Array(data),
    useSystemFonts: true,
    // Quieter: we don't need the font files just to read text positions.
    disableFontFace: true,
  }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(joinTextItems(content.items));
    // pdf.js caches aggressively; on a 300-page book that adds up.
    page.cleanup();
  }

  const info = await doc.getMetadata().catch(() => ({}));
  await doc.destroy();

  return {
    pages,
    checksum: checksum(data),
    meta: {
      pageCount: doc.numPages,
      title: info?.info?.Title?.trim() || null,
      author: info?.info?.Author?.trim() || null,
    },
  };
}

/**
 * Reassemble positioned text fragments into readable lines.
 *
 * pdf.js gives each fragment with a transform matrix; `transform[5]` is its vertical
 * position. Fragments at the same height belong to the same visual line — that's the
 * signal we use to put line breaks back, because the PDF itself doesn't have any.
 *
 * `hasEOL` is pdf.js's own guess at a line ending; we use it when offered and fall
 * back to the geometry when not.
 */
function joinTextItems(items) {
  let out = '';
  let lastY = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;

    const y = item.transform?.[5];
    // A vertical jump of more than ~2pt means a new line. Smaller differences are
    // usually just kerning or a subscript on the same line.
    const newLine = lastY !== null && y !== undefined && Math.abs(y - lastY) > 2;

    if (newLine) out += '\n';
    else if (out && !out.endsWith(' ') && !out.endsWith('\n') && !item.str.startsWith(' ')) {
      out += ' ';
    }

    out += item.str;
    if (item.hasEOL) out += '\n';
    if (y !== undefined) lastY = y;
  }

  return cleanText(out);
}

/**
 * Tidy the extracted text.
 *
 * Each of these is a real artefact of how PDFs store text, not hypothetical.
 */
function cleanText(text) {
  return (
    text
      // Ligatures: PDFs often store "fi" as the single glyph "ﬁ", which then fails to
      // match a search for "find".
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬀ/g, 'ff')
      // A word hyphenated across a line break: "entitle-\nment" → "entitlement".
      .replace(/(\w)-\n(\w)/g, '$1$2')
      // Collapse runs of spaces (PDFs pad with spaces to achieve alignment).
      .replace(/[ \t]{2,}/g, ' ')
      // Collapse 3+ newlines into a paragraph break.
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  );
}

/**
 * Decide whether this document is usable, and say so clearly if not.
 *
 * A scanned PDF is a stack of photographs. It opens fine, reports the right number of
 * pages, and yields essentially no text. Without this check you'd ingest it, build an
 * index over nothing, and spend an hour wondering why retrieval never finds anything.
 */
export function assessExtraction(pages) {
  const totalChars = pages.reduce((n, p) => n + p.length, 0);
  const emptyPages = pages.filter((p) => p.trim().length < 20).length;
  const charsPerPage = pages.length ? Math.round(totalChars / pages.length) : 0;

  const problems = [];

  if (totalChars < 200) {
    problems.push(
      'Almost no text could be extracted. This is very likely a SCANNED PDF — ' +
        'a stack of images rather than text. Reading it would need OCR (Tesseract), ' +
        'which this project does not do.',
    );
  } else if (emptyPages > pages.length * 0.5) {
    problems.push(
      `${emptyPages} of ${pages.length} pages yielded almost no text. The document may ` +
        'be partly scanned, or heavily image-based.',
    );
  } else if (charsPerPage < 150) {
    problems.push(
      `Only ~${charsPerPage} characters per page. That is low — expect mostly images, ` +
        'or a layout pdf.js is struggling with.',
    );
  }

  return {
    ok: problems.length === 0,
    totalChars,
    charsPerPage,
    emptyPages,
    problems,
  };
}

/**
 * Find lines that repeat on most pages — running headers and footers.
 *
 * Why bother: a header like "ACME HANDBOOK — CONFIDENTIAL" on all 300 pages ends up in
 * hundreds of chunks. It adds no meaning, dilutes every embedding slightly, and wastes
 * input tokens on every single retrieval.
 *
 * @returns {Set<string>} normalised lines to drop
 */
export function detectRepeatedLines(pages, threshold = 0.6) {
  if (pages.length < 4) return new Set(); // too few pages to tell a header from content

  const counts = new Map();
  for (const page of pages) {
    // Only the first and last few lines can be a running header or footer.
    const lines = page.split('\n').map((l) => l.trim()).filter(Boolean);
    const candidates = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const line of new Set(candidates)) {
      // Normalise page numbers away, so "Page 7 of 300" and "Page 8 of 300" count
      // as the same running footer.
      const key = line.replace(/\d+/g, '#');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const repeated = new Set();
  for (const [key, count] of counts) {
    if (count >= pages.length * threshold) repeated.add(key);
  }
  return repeated;
}

export function stripRepeatedLines(page, repeated) {
  if (!repeated.size) return page;
  return page
    .split('\n')
    .filter((line) => !repeated.has(line.trim().replace(/\d+/g, '#')))
    .join('\n');
}
