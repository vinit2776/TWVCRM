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
const IRN_REGEX = /\b([a-f0-9]{64})\b/i;
const GSTIN_REGEX = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2})\b/;
const DATE_DDMMMYYYY = /\b(\d{1,2})[-\s]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]*(\d{4})\b/i;
const DATE_DDMMYYYY = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/;
const TOTAL_AMOUNT_REGEX = /total\s+(?:invoice\s+)?(?:value|amount)[^\d]*([\d,]+\.\d{2})/i;
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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
 * Extract Tally invoice fields from a PDF buffer.
 *
 * Returns whatever it could find. Caller checks which fields are present and
 * decides whether to fall back to bridge match or accept partial autofill.
 */
export async function extractFromPdf(pdfBuffer: Buffer): Promise<PdfExtractResult> {
  // pdf-parse is CJS and reads a magic-byte sample file at module load; we
  // require it lazily so a missing fixture doesn't crash module init.
  const { default: pdfParse } = (await import("pdf-parse")) as unknown as {
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
    };
  }

  if (!text.trim()) {
    return {
      fields: {},
      raw_text_snippet: null,
      source: "manual",
    };
  }

  const invoiceNumberMatch = text.match(INVOICE_NUMBER_REGEX);
  const invoiceNumber = invoiceNumberMatch ? invoiceNumberMatch[0].toUpperCase() : null;
  const series: "SDIPL-REG" | "SDIPL-UNREG" | null = invoiceNumber
    ? invoiceNumber.startsWith("SD/A/") ? "SDIPL-REG" : "SDIPL-UNREG"
    : null;

  const irnMatch = text.match(IRN_REGEX);
  const irn = irnMatch ? irnMatch[1].toLowerCase() : null;

  const gstinMatch = text.match(GSTIN_REGEX);
  const partyGstin = gstinMatch ? gstinMatch[1] : null;

  const invoiceDate = parseDdMmmYyyy(text) ?? parseDdMmYyyy(text);
  const invoiceAmount = parseAmount(text);

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
  };
}
