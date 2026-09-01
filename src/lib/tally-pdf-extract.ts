/**
 * Tally GST invoice PDF — server-side extraction helpers.
 *
 * Given a PDF buffer, extracts the fields the upload form needs so accounts
 * doesn't have to type them. Cascade per docs/tally-handoff-redesign.md §8:
 *
 *   1. (this module) PDF text parse → invoice number, IRN, amount, GSTIN
 *   2. (caller) bridge match → confirm against tally_voucher_snapshots
 *   3. (caller) manual entry → fallback when text parse can't read
 *
 * QR code scan (browser-side via pdfjs-dist + jsqr) is a follow-up;
 * server-side rasterisation isn't viable on Vercel without native deps.
 */

import type { ExtractedFields, AutofillSource } from "@/lib/tally-handoff";

export interface PdfExtractResult {
  fields: ExtractedFields;
  raw_text_snippet: string | null;
  source: AutofillSource;
  po_number_found: boolean | null;
}

/**
 * Regexes tuned for Tally's SDIPL invoice templates.
 *
 *   Invoice number: SD/A/26-27/175 (REG) or SD/B/26-27/12 (UNREG)
 *   IRN:            64-char hex, printed on B2B e-invoices below the QR
 *   GSTIN:          standard 15-char format
 *   Date:           Tally prints multiple formats; we match dd-MMM-yyyy first
 *                   ("19-May-2026"), then dd/mm/yyyy
 *   Amount:         "Total Invoice Value" line followed by the number
 */
const INVOICE_NUMBER_REGEX = /SD\/(?:A|B)\/\d{2}-\d{2}\/\d+/i;
const GSTIN_REGEX = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2})\b/;
const DATE_DDMMMYYYY = /\b(\d{1,2})[-\s]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]*(\d{4})\b/i;
const DATE_DDMMYYYY = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/;
const TOTAL_AMOUNT_REGEX = /total\s+(?:invoice\s+)?(?:value|amount)[^\d]*([\d,]+\.\d{2})/i;
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Extract a 64-char IRN from PDF text.
 *
 * Tally PDFs surface the IRN in a few different ways depending on the version
 * and template:
 *   1. "IRN: <64-char hex>" on one line
 *   2. "IRN" label on one line, hex value on the next (column-based layout)
 *   3. Hex value spread over two lines due to column width limits (e.g. 32+32)
 *   4. Standalone 64-char hex string elsewhere in the page
 *
 * We try each strategy in order and return the first confident match.
 */
function findIrn(text: string): string | null {
  // Strategy 1: "IRN" label with optional colon/space, then hex (same or next line).
  // Captures up to 140 chars after the label to handle whitespace-split values.
  const labelMatch = text.match(/\bIRN\b[\s:]*([a-f0-9][\s\S]{60,138})/i);
  if (labelMatch) {
    const candidate = labelMatch[1].replace(/\s+/g, "").slice(0, 64);
    if (candidate.length === 64 && /^[a-f0-9]{64}$/i.test(candidate)) {
      return candidate.toLowerCase();
    }
  }

  // Strategy 2: Standalone 64-char hex not adjacent to more hex chars.
  // Negative lookbehind/ahead ensures we don't clip a longer string.
  const exactMatch = text.match(/(?<![a-f0-9])([a-f0-9]{64})(?![a-f0-9])/i);
  if (exactMatch) return exactMatch[1].toLowerCase();

  return null;
}

function parseDdMmmYyyy(s: string): string | null {
  const m = s.match(DATE_DDMMMYYYY);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
  const year = parseInt(m[3], 10);
  if (Number.isNaN(day) || month === undefined || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function parseDdMmYyyy(s: string): string | null {
  const m = s.match(DATE_DDMMYYYY);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  if (Number.isNaN(day) || month < 0 || month > 11 || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function parseAmount(s: string): number | null {
  const m = s.match(TOTAL_AMOUNT_REGEX);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

/**
 * True iff `expectedPoNumber` appears in `text`, ignoring case and treating
 * runs of whitespace as equivalent — pdf-parse sometimes splits a PO number
 * across a line break or collapses/expands spacing around it.
 */
function textContainsPoNumber(text: string, expectedPoNumber: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  const needle = normalize(expectedPoNumber);
  if (!needle) return false;
  return normalize(text).includes(needle);
}

/**
 * Extract Tally invoice fields from a PDF buffer.
 *
 * Returns whatever it could find. Caller checks which fields are present and
 * decides whether to fall back to bridge match or accept partial autofill.
 *
 * `expectedPoNumber` — when the statement being uploaded against has a
 * Customer PO Number on file, pass it in to get back `po_number_found`: a
 * check against the *full* extracted text (not just the 200-char snippet)
 * confirming accounts actually put it on the Tally invoice.
 */
export async function extractFromPdf(pdfBuffer: Buffer, expectedPoNumber?: string | null): Promise<PdfExtractResult> {
  // pdf-parse's index.js has a debug-mode path that calls
  // fs.readFileSync('./test/data/05-versions-space.pdf') relative to CWD.
  // In Next.js (webpack/Turbopack), module.parent is unset so isDebugMode=true
  // and the readFileSync throws ENOENT before any parsing occurs.
  // Importing the inner lib directly bypasses that broken entry point entirely.
  // @ts-expect-error — no type declarations for pdf-parse sub-path export
  const { default: pdfParse } = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as {
    default: (buf: Buffer) => Promise<{ text: string }>;
  };

  let text = "";
  try {
    const parsed = await pdfParse(pdfBuffer);
    text = parsed.text || "";
  } catch {
    return {
      fields: {},
      raw_text_snippet: null,
      source: "manual",
      po_number_found: null,
    };
  }

  if (!text.trim()) {
    return {
      fields: {},
      raw_text_snippet: null,
      source: "manual",
      po_number_found: null,
    };
  }

  const invoiceNumberMatch = text.match(INVOICE_NUMBER_REGEX);
  const invoiceNumber = invoiceNumberMatch ? invoiceNumberMatch[0].toUpperCase() : null;
  const series: "SDIPL-REG" | "SDIPL-UNREG" | null = invoiceNumber
    ? invoiceNumber.startsWith("SD/A/") ? "SDIPL-REG" : "SDIPL-UNREG"
    : null;

  const irn = findIrn(text);

  const gstinMatch = text.match(GSTIN_REGEX);
  const partyGstin = gstinMatch ? gstinMatch[1] : null;

  const invoiceDate = parseDdMmmYyyy(text) ?? parseDdMmYyyy(text);
  const invoiceAmount = parseAmount(text);

  const poNumberFound = expectedPoNumber?.trim()
    ? textContainsPoNumber(text, expectedPoNumber)
    : null;

  return {
    fields: {
      invoice_number: invoiceNumber ?? undefined,
      series: series ?? undefined,
      irn: irn ?? undefined,
      party_gstin: partyGstin ?? undefined,
      invoice_date: invoiceDate ?? undefined,
      invoice_amount: invoiceAmount ?? undefined,
    },
    raw_text_snippet: text.slice(0, 200),
    source: "pdf_text",
    po_number_found: poNumberFound,
  };
}
