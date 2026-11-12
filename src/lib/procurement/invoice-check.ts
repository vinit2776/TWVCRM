// Advisory comparison between what a user typed on the bill form and what was read
// off the uploaded invoice. Pure — nothing here blocks submission or edits a field;
// every finding that has a `suggestion` is applied only if the user clicks it.
import { z } from "zod";

export type ExtractionConfidence = "high" | "medium" | "low";

/** One charge row printed on the invoice (a meter's grid units, DG units, a fixed charge). Never a total or tax row. */
export interface ExtractedLine {
  description: string | null;
  kind: "utility" | "generator" | "other" | null;
  units: number | null;
  rate: number | null;
  amount: number | null;
}

export interface ExtractedInvoice {
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  vendorName: string | null;
  subtotal: number | null; // pre-GST
  gstAmount: number | null;
  grandTotal: number | null;
  confidence: ExtractionConfidence;
  /** Only read for electricity bills; undefined/empty means the charge lines were not read. */
  lines?: ExtractedLine[] | null;
}

/** A charge line as typed on the form. */
export interface EnteredLine {
  line_type: "utility" | "generator" | "other";
  units: number | null;
  rate: number | null;
  amount: number;
}

export interface EnteredBill {
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string | null;
  /** The "Invoice Amount" field — expects the pre-GST amount. */
  amount: number | null;
  gstAmount: number | null;
  /** Electricity bills: the charge lines, compared one by one with the invoice. */
  lines?: EnteredLine[];
  /** Electricity bills: GST rate in force (0 when off); part of what the seal is tied to. */
  gstRate?: number | null;
}

export type InvoiceFindingCode =
  | "line_not_on_invoice"
  | "line_category_differs"
  | "invoice_line_not_entered"
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

const UNITS_TOLERANCE = 0.05;
const RATE_TOLERANCE = 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;
const KIND_LABEL = { utility: "Utility/Grid", generator: "Generator", other: "Other charge" } as const;

function describeEntered(l: EnteredLine): string {
  if (l.line_type === "other") return `${KIND_LABEL.other} ${inr(l.amount)}`;
  return `${KIND_LABEL[l.line_type]} ${l.units ?? 0} units × ${inr(l.rate ?? 0)} = ${inr(l.amount)}`;
}
function describeInvoiceLine(l: ExtractedLine): string {
  const name = l.description ? `“${l.description}” ` : "";
  const figures = l.units !== null && l.rate !== null ? `${l.units} units × ${inr(l.rate)} ` : "";
  return `${name}${figures}${l.amount !== null ? `= ${inr(l.amount)}` : ""}`.trim();
}

export type LineMatchStatus = "match" | "category_differs" | "not_on_invoice";
export interface LineMatch {
  entered: EnteredLine;
  status: LineMatchStatus;
  /** The invoice row it was paired with, when there is one. */
  invoice: ExtractedLine | null;
}

/**
 * Pairs each typed charge line with a row printed on the invoice by its figures (units, rate, amount),
 * not by wording, because landlords label the same charge in many ways. Each invoice row is used once.
 * A pair whose figures agree but whose kind (grid versus generator) does not is flagged separately:
 * the customer's bill is re-split from exactly this, so it is the mistake that matters most.
 */
export function compareLines(invoiceLines: ExtractedLine[], enteredLines: EnteredLine[]) {
  const free = invoiceLines.map((l, i) => ({ l, i, used: false }));
  const matches: LineMatch[] = [];

  const figuresAgree = (e: EnteredLine, x: ExtractedLine) => {
    const amountOk = x.amount !== null && near(e.amount, x.amount);
    if (e.line_type === "other") return amountOk;
    const unitsOk = x.units !== null && Math.abs((e.units ?? 0) - x.units) <= UNITS_TOLERANCE;
    const rateOk = x.rate === null || e.rate === null || Math.abs(e.rate - x.rate) <= RATE_TOLERANCE;
    return unitsOk && rateOk && (x.amount === null || amountOk);
  };

  for (const e of enteredLines) {
    const hit = free.find((f) => !f.used && figuresAgree(e, f.l));
    if (!hit) {
      matches.push({ entered: e, status: "not_on_invoice", invoice: null });
      continue;
    }
    hit.used = true;
    const kindDiffers = e.line_type !== "other" && hit.l.kind !== null && hit.l.kind !== "other" && hit.l.kind !== e.line_type;
    matches.push({ entered: e, status: kindDiffers ? "category_differs" : "match", invoice: hit.l });
  }

  const findings: InvoiceFinding[] = [];
  for (const m of matches) {
    if (m.status === "not_on_invoice") {
      findings.push({ code: "line_not_on_invoice", message: `You entered ${describeEntered(m.entered)}; nothing on the invoice has those figures.` });
    } else if (m.status === "category_differs" && m.invoice) {
      findings.push({
        code: "line_category_differs",
        message: `${describeEntered(m.entered)} matches an invoice row that is ${KIND_LABEL[m.invoice.kind as "utility" | "generator"]}, but you entered it as ${KIND_LABEL[m.entered.line_type]}.`,
      });
    }
  }
  for (const f of free) {
    if (!f.used && (f.l.amount ?? 0) > AMOUNT_TOLERANCE) {
      findings.push({ code: "invoice_line_not_entered", message: `The invoice has ${describeInvoiceLine(f.l)} that is not in your entries.` });
    }
  }
  return { matches, findings, unmatchedInvoice: free.filter((f) => !f.used).map((f) => f.l) };
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

  if (entered.lines && extracted.lines && extracted.lines.length > 0) {
    findings.push(...compareLines(extracted.lines, entered.lines).findings);
  }

  return findings;
}

/**
 * Stands for "the charge lines and GST as they were when the invoice was checked". The seal is only
 * shown while the bill still matches it, so editing a bill after the check can't keep the seal.
 */
export function fingerprintLines(lines: EnteredLine[], gstRate: number | null | undefined): string {
  // Metered rows are identified by units and rate (what is stored); a typed row total can differ from
  // units × rate by paise, and must not make an untouched bill look edited.
  const rows = lines.map((l) =>
    l.line_type === "other" ? `other|${r2(l.amount)}` : `${l.line_type}|${r2(l.units ?? 0)}|${Math.round((l.rate ?? 0) * 10000) / 10000}`,
  );
  return `${rows.join(";")}#gst${r2(gstRate ?? 0)}`;
}

/** What is kept with the bill so the approver sees the same warning the form showed (migration 00676). */
export const invoiceCheckRecordSchema = z.object({
  checked_at: z.string().max(40),
  confidence: z.enum(["high", "medium", "low"]),
  findings: z.array(z.object({ code: z.string().max(60), message: z.string().max(400) })).max(20),
  /** Why the person saved with differences still open (required by the electricity capture forms). */
  override_reason: z.string().trim().max(500).optional(),
  /** True only when the invoice's charge lines were read and compared; absent on older records. */
  lines_checked: z.boolean().optional(),
  /** See fingerprintLines; absent on older records. */
  entered_fingerprint: z.string().max(2000).optional(),
});
export type InvoiceCheckRecord = z.infer<typeof invoiceCheckRecordSchema>;

export function buildInvoiceCheckRecord(
  extracted: ExtractedInvoice,
  findings: InvoiceFinding[],
  overrideReason?: string,
  entered?: EnteredBill,
): InvoiceCheckRecord {
  const linesChecked = !!(entered?.lines && extracted.lines && extracted.lines.length > 0);
  return {
    checked_at: new Date().toISOString(),
    confidence: extracted.confidence,
    findings: findings.map((f) => ({ code: f.code, message: f.message })),
    ...(overrideReason && overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}),
    ...(entered?.lines ? { lines_checked: linesChecked, entered_fingerprint: fingerprintLines(entered.lines, entered.gstRate) } : {}),
  };
}

export type InvoiceSealState = "verified" | "overridden" | "not_verified" | "changed_after";
export interface InvoiceSeal {
  state: InvoiceSealState;
  /** One line a person can read: why it is, or isn't, sealed. */
  reason: string;
}

/**
 * Verified means: the invoice was read clearly, every charge line and the totals matched, nobody had to
 * override a difference, and the bill hasn't been edited since. Anything less is never shown as verified.
 */
export function invoiceSeal(record: InvoiceCheckRecord | null | undefined, currentFingerprint: string | null): InvoiceSeal {
  if (!record) return { state: "not_verified", reason: "The invoice was not checked against the entries. Compare them yourself." };
  if (currentFingerprint !== null && record.entered_fingerprint !== undefined && record.entered_fingerprint !== currentFingerprint) {
    return { state: "changed_after", reason: "The bill was edited after the invoice was checked. Compare it with the invoice again." };
  }
  if (record.findings.length > 0) {
    return { state: "overridden", reason: record.override_reason ? `reason given: “${record.override_reason}”` : "it differed from the invoice." };
  }
  if (record.confidence === "low") return { state: "not_verified", reason: "The invoice was hard to read. Compare it with the entries yourself." };
  if (!record.lines_checked) return { state: "not_verified", reason: "The charge lines were not read from the invoice. Compare them yourself." };
  return { state: "verified", reason: "Bill number, date, vendor, every charge line, GST and total match the invoice." };
}
