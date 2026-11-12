// Advisory comparison between what a user typed on the bill form and what was read
// off the uploaded invoice. Pure — nothing here blocks submission or edits a field;
// every finding that has a `suggestion` is applied only if the user clicks it.
import { z } from "zod";

export type ExtractionConfidence = "high" | "medium" | "low";

export interface ExtractedInvoice {
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  vendorName: string | null;
  subtotal: number | null; // pre-GST
  gstAmount: number | null;
  grandTotal: number | null;
  confidence: ExtractionConfidence;
}

export interface EnteredBill {
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string | null;
  /** The "Invoice Amount" field — expects the pre-GST amount. */
  amount: number | null;
  gstAmount: number | null;
}

export type InvoiceFindingCode =
  | "amount_looks_gst_inclusive"
  | "amount_differs_subtotal"
  | "gst_differs"
  | "invoice_number_mismatch"
  | "invoice_date_mismatch"
  | "vendor_mismatch"
  | "amount_above_po";

export type SuggestionField = "amount" | "gstAmount" | "invoiceNumber" | "invoiceDate";

export interface InvoiceFinding {
  code: InvoiceFindingCode;
  message: string;
  suggestion?: { field: SuggestionField; value: string; label: string };
}

// Rupee rounding on invoices means totals rarely agree to the paisa.
const AMOUNT_TOLERANCE = 1;

const near = (a: number, b: number) => Math.abs(a - b) <= AMOUNT_TOLERANCE;
const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fixed = (n: number) => String(Math.round(n * 100) / 100);

const COMPANY_NOISE = new Set([
  "pvt", "private", "ltd", "limited", "llp", "co", "company", "inc", "ms", "m", "s", "and", "the", "opc",
]);

function vendorTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !COMPANY_NOISE.has(t));
}

/** Edit distance, bounded: returns max+1 as soon as it is certain to exceed max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// A scanned landlord bill is read with small mistakes (a dropped letter, a split or joined word),
// so a name still counts as the same when it is close, not only when it is identical.
const tokenClose = (x: string, y: string) => {
  if (x === y) return true;
  const longest = Math.max(x.length, y.length);
  if (longest < 4) return false; // too short to forgive anything
  return editDistance(x, y, longest >= 8 ? 2 : 1) <= (longest >= 8 ? 2 : 1);
};

export function vendorNamesMatch(a: string, b: string): boolean {
  const ta = vendorTokens(a);
  const tb = vendorTokens(b);
  if (ta.length === 0 || tb.length === 0) return true; // nothing comparable — stay quiet

  // "Prakash Chand" vs "Prakashchand": spacing differences vanish when the words are joined.
  const ja = ta.join("");
  const jb = tb.join("");
  if (ja === jb || (Math.max(ja.length, jb.length) >= 8 && editDistance(ja, jb, 2) <= 2)) return true;

  const sa = new Set(ta);
  const sb = new Set(tb);
  const shared = [...sa].filter((x) => [...sb].some((y) => tokenClose(x, y))).length;
  return shared / Math.min(sa.size, sb.size) >= 0.5;
}

// Letters a scan commonly confuses with digits. Only these are forgiven in an invoice number —
// any other difference is a real mismatch, since a single wrong digit is exactly the mistake to catch.
const OCR_LOOKALIKES: Record<string, string> = { o: "0", q: "0", i: "1", l: "1", s: "5", b: "8", z: "2" };
const normaliseInvoiceNumber = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/[oqilsbz]/g, (c) => OCR_LOOKALIKES[c]);

/** Fill the gaps arithmetic allows (subtotal = total − GST etc.) without inventing anything. */
export function completeAmounts(x: ExtractedInvoice): {
  subtotal: number | null;
  gst: number | null;
  total: number | null;
} {
  let { subtotal, gstAmount: gst, grandTotal: total } = x;
  if (subtotal === null && total !== null && gst !== null) subtotal = Math.round((total - gst) * 100) / 100;
  if (gst === null && total !== null && subtotal !== null) gst = Math.round((total - subtotal) * 100) / 100;
  if (total === null && subtotal !== null && gst !== null) total = Math.round((subtotal + gst) * 100) / 100;
  return { subtotal, gst, total };
}

export function checkInvoice({
  extracted,
  entered,
  poCeiling,
}: {
  extracted: ExtractedInvoice;
  entered: EnteredBill;
  /** PO value (or received value on a short delivery); null when there is no PO. */
  poCeiling: number | null;
}): InvoiceFinding[] {
  const findings: InvoiceFinding[] = [];
  const { subtotal, gst, total } = completeAmounts(extracted);

  if (entered.amount !== null && entered.amount > 0) {
    const gstOnInvoice = gst !== null && gst > AMOUNT_TOLERANCE;
    const enteredIsGrandTotal = total !== null && near(entered.amount, total);

    if (enteredIsGrandTotal && gstOnInvoice && subtotal !== null && !near(subtotal, total!)) {
      // The BILL-2610-019 case: the field takes the pre-GST amount, the user typed the grand total.
      findings.push({
        code: "amount_looks_gst_inclusive",
        message: `This looks GST-inclusive. The invoice total is ${inr(total!)} (${inr(subtotal)} + ${inr(gst!)} GST), and this field expects the amount before GST.`,
        suggestion: { field: "amount", value: fixed(subtotal), label: `Use ${inr(subtotal)}` },
      });
    } else if (subtotal !== null && !near(entered.amount, subtotal)) {
      findings.push({
        code: "amount_differs_subtotal",
        message: `The invoice shows ${inr(subtotal)} before GST; you entered ${inr(entered.amount)}.`,
        suggestion: { field: "amount", value: fixed(subtotal), label: `Use ${inr(subtotal)}` },
      });
    }
  }

  if (gst !== null && entered.gstAmount !== null && entered.gstAmount > 0 && !near(entered.gstAmount, gst)) {
    findings.push({
      code: "gst_differs",
      message: `The invoice shows ${inr(gst)} GST; you entered ${inr(entered.gstAmount)}.`,
      suggestion: { field: "gstAmount", value: fixed(gst), label: `Use ${inr(gst)}` },
    });
  }

  if (
    extracted.invoiceNumber &&
    entered.invoiceNumber.trim() &&
    normaliseInvoiceNumber(extracted.invoiceNumber) !== normaliseInvoiceNumber(entered.invoiceNumber)
  ) {
    findings.push({
      code: "invoice_number_mismatch",
      message: `The invoice number reads “${extracted.invoiceNumber}”; you entered “${entered.invoiceNumber.trim()}”.`,
      suggestion: { field: "invoiceNumber", value: extracted.invoiceNumber, label: `Use ${extracted.invoiceNumber}` },
    });
  }

  if (extracted.invoiceDate && entered.invoiceDate && extracted.invoiceDate !== entered.invoiceDate) {
    findings.push({
      code: "invoice_date_mismatch",
      message: `The invoice is dated ${extracted.invoiceDate}; the form has ${entered.invoiceDate}.`,
      suggestion: { field: "invoiceDate", value: extracted.invoiceDate, label: `Use ${extracted.invoiceDate}` },
    });
  }

  if (extracted.vendorName && entered.vendorName && !vendorNamesMatch(extracted.vendorName, entered.vendorName)) {
    findings.push({
      code: "vendor_mismatch",
      message: `The invoice is from “${extracted.vendorName}”; the selected vendor is “${entered.vendorName}”.`,
    });
  }

  if (poCeiling !== null && poCeiling > 0) {
    // Judge what the user actually typed; if nothing yet, what the invoice implies.
    const compared = entered.amount ?? subtotal;
    if (compared !== null && compared > poCeiling + AMOUNT_TOLERANCE) {
      findings.push({
        code: "amount_above_po",
        message: `${inr(compared)} is above the PO limit of ${inr(poCeiling)}.`,
      });
    }
  }

  return findings;
}

/** What is kept with the bill so the approver sees the same warning the form showed (migration 00676). */
export const invoiceCheckRecordSchema = z.object({
  checked_at: z.string().max(40),
  confidence: z.enum(["high", "medium", "low"]),
  findings: z.array(z.object({ code: z.string().max(60), message: z.string().max(400) })).max(20),
  /** Why the person saved with differences still open (required by the electricity capture forms). */
  override_reason: z.string().trim().max(500).optional(),
});
export type InvoiceCheckRecord = z.infer<typeof invoiceCheckRecordSchema>;

export function buildInvoiceCheckRecord(extracted: ExtractedInvoice, findings: InvoiceFinding[], overrideReason?: string): InvoiceCheckRecord {
  return {
    checked_at: new Date().toISOString(),
    confidence: extracted.confidence,
    findings: findings.map((f) => ({ code: f.code, message: f.message })),
    ...(overrideReason && overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}),
  };
}
