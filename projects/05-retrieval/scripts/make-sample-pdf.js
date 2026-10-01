/**
 * Generates a small, text-based sample PDF with KNOWN content.
 *
 * Why this exists: you need a document where you already know every fact, so you can
 * tell the difference between "retrieved correctly" and "sounded plausible". With a real
 * book you're guessing. With this you can write test questions whose answers you can
 * verify by eye, including questions whose answers are deliberately NOT in the document
 * so the system has to refuse.
 *
 * It writes a genuine PDF by hand — a PDF is mostly plain text with a byte-offset table
 * at the end, so no library is needed.
 *
 *   node scripts/make-sample-pdf.js
 *   → docs/acme-handbook.pdf
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// The content. Deliberately full of SPECIFIC, CHECKABLE facts — numbers, names,
// codes — because vague prose makes it impossible to tell retrieval from invention.
//
// Note the near-duplicate sections (grade 5 vs grade 7 leave, the two refund windows).
// Those are the retrieval equivalent of project 04's "order A-1001 vs A-1002": they
// embed almost identically and have different answers.
// ─────────────────────────────────────────────────────────────────────────────
const PAGES = [
  [
    'ACME CORPORATION EMPLOYEE HANDBOOK',
    'Revision 7.2, effective 1 April 2026',
    '',
    'SECTION 1: WORKING HOURS',
    '',
    'Standard working hours are 09:30 to 18:00, Monday to Friday, with a',
    'one hour unpaid lunch break. Core hours, during which all staff must be',
    'available, are 11:00 to 16:00.',
    '',
    'Staff may work remotely up to 3 days per week with manager approval.',
    'Fully remote arrangements require approval from a department head and',
    'are reviewed every 6 months.',
    '',
    'Overtime is compensated at 1.5 times the standard hourly rate and must',
    'be approved in advance. Overtime worked on a public holiday is',
    'compensated at 2.0 times the standard rate.',
  ],
  [
    'SECTION 2: ANNUAL LEAVE',
    '',
    'Annual leave entitlement depends on employment grade.',
    '',
    'A grade 5 employee receives 22 days of annual leave per year.',
    'A grade 7 employee receives 28 days of annual leave per year.',
    'A grade 9 employee receives 32 days of annual leave per year.',
    '',
    'Up to 5 unused days may be carried into the following year. Carried',
    'days expire on 31 March. Days beyond that limit are forfeited and are',
    'not paid out, except on termination of employment.',
    '',
    'Leave requests of more than 10 consecutive working days require',
    'approval from a department head and 30 days notice.',
  ],
  [
    'SECTION 3: EXPENSES',
    '',
    'Expense claims must be submitted within 60 days of the expense being',
    'incurred. Claims submitted after 60 days require written justification',
    'and approval from the Finance Director.',
    '',
    'Meal allowance when travelling domestically is 1200 rupees per day.',
    'Meal allowance when travelling internationally is 4500 rupees per day.',
    '',
    'Accommodation must be booked through the corporate travel portal.',
    'Bookings made outside the portal are reimbursed only up to the rate',
    'that would have applied through the portal.',
    '',
    'Taxi fares are reimbursed in full for journeys before 07:00 or after',
    '22:00. At other times, public transport rates apply.',
  ],
  [
    'SECTION 4: EQUIPMENT AND SECURITY',
    '',
    'Each employee is issued one laptop and one monitor. Replacement',
    'equipment is issued every 4 years, or sooner if hardware fails.',
    '',
    'Equipment must be returned within 5 working days of the final day of',
    'employment. Unreturned equipment is deducted from the final salary',
    'payment at its depreciated value.',
    '',
    'Passwords must be at least 14 characters. Multi-factor authentication',
    'is mandatory for all systems holding customer data.',
    '',
    'Security incidents must be reported to security@acme.example within',
    '24 hours of discovery. Incident ticket numbers use the format SEC-0001.',
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
// Minimal PDF writer.
//
// A PDF is a set of numbered objects, then a cross-reference table listing the BYTE
// OFFSET of each one, then a trailer pointing at the table. Readers jump straight to
// the offsets, which is why those numbers must be exactly right.
// ─────────────────────────────────────────────────────────────────────────────

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Turn an array of lines into a PDF content stream (text drawing commands). */
function contentStream(lines) {
  const body = lines
    .map((line, i) => (i === 0 ? `(${escape(line)}) Tj` : `T* (${escape(line)}) Tj`))
    .join('\n');
  // BT = begin text, Tf = font + size, TL = line spacing, Td = position,
  // T* = next line, Tj = show text, ET = end text.
  return `BT\n/F1 11 Tf\n16 TL\n56 760 Td\n${body}\nET`;
}

function buildPdf(pages) {
  const objects = [];
  const pageObjIds = pages.map((_, i) => 4 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((lines, i) => {
    const pageId = pageObjIds[i];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = contentStream(lines);
    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  // Assemble, recording where each object starts.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  // The cross-reference table: one fixed-width line per object, 20 bytes each.
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'docs');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'acme-handbook.pdf');

writeFileSync(outPath, buildPdf(PAGES));
console.log(`▸ wrote ${outPath}`);
console.log(`  ${PAGES.length} pages, ${PAGES.flat().filter(Boolean).length} lines of known content`);
