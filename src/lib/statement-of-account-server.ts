import jsPDF from "jspdf";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BRAND_DARK, BRAND_TEAL, addBrandHeader, addFooter, createPdfContext, formatCurrency, formatDate,
} from "@/lib/pdf-utils";
import {
  buildLedger, soaRange, type SoaLedger, type SoaPaymentInput, type SoaStatementInput,
} from "@/lib/statement-of-account";

const STATEMENT_COLUMNS =
  "id, status, statement_number, gst_invoice_number, total_amount, voided_at, proforma_sent_at, emailed_at, finalized_at, created_at, period_start, period_end, statement_type";

interface LeadParty {
  name: string;
  address: string | null;
  gstin: string | null;
}

export interface SoaResult {
  ledger: SoaLedger;
  party: LeadParty;
}

/**
 * Everything billed to a lead, whichever way the statement hangs off it:
 * directly, through a contract, proposal, ad-hoc invoice or booking.
 * Read-only.
 */
export async function loadStatementOfAccount(
  admin: SupabaseClient,
  leadId: string,
  fyStartYear: number,
): Promise<SoaResult | null> {
  const { data: lead } = await admin
    .from("leads")
    .select("first_name, last_name, company, gst_number, street, city, state, zip_code")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return null;

  const idsOf = async (table: string): Promise<string[]> => {
    const { data } = await admin.from(table).select("id").eq("lead_id", leadId);
    return (data || []).map((r) => r.id as string);
  };
  const [contracts, proposals, invoices, bookings] = await Promise.all([
    idsOf("contracts"), idsOf("proposals"), idsOf("proforma_invoices"), idsOf("bookings"),
  ]);

  const owners: Array<[string, string[]]> = [
    ["contract_id", contracts], ["proposal_id", proposals], ["invoice_id", invoices], ["booking_id", bookings],
  ];
  const ors = [`lead_id.eq.${leadId}`, ...owners.filter(([, ids]) => ids.length).map(([col, ids]) => `${col}.in.(${ids.join(",")})`)];
  const { data: statements, error } = await admin
    .from("billing_statements")
    .select(STATEMENT_COLUMNS)
    .or(ors.join(","))
    .not("status", "in", "(draft,voided,discarded)")
    .is("voided_at", null);
  if (error) throw new Error(error.message);

  const stmts = (statements || []) as unknown as SoaStatementInput[];
  let payments: SoaPaymentInput[] = [];
  if (stmts.length) {
    const { data: pays, error: payErr } = await admin
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount, payment_date, payment_mode, payment_reference")
      .in("billing_statement_id", stmts.map((s) => s.id));
    if (payErr) throw new Error(payErr.message);
    payments = (pays || []) as SoaPaymentInput[];
  }

  const name = lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Customer";
  const address = [lead.street, lead.city, lead.state, lead.zip_code].filter(Boolean).join(", ") || null;
  return {
    ledger: buildLedger(stmts, payments, soaRange(fyStartYear)),
    party: { name, address, gstin: (lead.gst_number as string | null) || null },
  };
}

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

const COLS = { date: 15, doc: 38, part: 76, debit: 128, credit: 150, bal: 195 } as const;

export function buildStatementOfAccountPdf({ ledger, party }: SoaResult): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = addBrandHeader(doc);
  const ctx = createPdfContext(doc, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("STATEMENT OF ACCOUNT", 15, y);
  y += 7;
  doc.setFontSize(9);
  doc.setTextColor(...BRAND_DARK);
  doc.text(`${ledger.range.label}  (${formatDate(ledger.range.from)} to ${formatDate(ledger.range.to)})`, 15, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.text(`Prepared on ${formatDate(new Date())}`, 15, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(party.name, 15, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  if (party.address) { doc.text(doc.splitTextToSize(party.address, 120), 15, y); y += 4.5; }
  if (party.gstin) { doc.text(`GSTIN: ${party.gstin}`, 15, y); y += 4.5; }
  y += 3;
  ctx.y = y;

  const header = () => {
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(15, ctx.y - 4.5, 180, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("Date", COLS.date + 1, ctx.y);
    doc.text("Document", COLS.doc, ctx.y);
    doc.text("Particulars", COLS.part, ctx.y);
    doc.text("Debit", COLS.credit - 3, ctx.y, { align: "right" });
    doc.text("Credit", COLS.bal - 30, ctx.y, { align: "right" });
    doc.text("Balance", COLS.bal - 1, ctx.y, { align: "right" });
    ctx.y += 6;
  };
  const line = (cells: { date: string; doc: string; part: string; debit: string; credit: string; bal: string }, bold = false) => {
    const partLines = doc.splitTextToSize(cells.part, 50) as string[];
    const docLines = doc.splitTextToSize(cells.doc, 36) as string[];
    const h = Math.max(partLines.length, docLines.length) * 4 + 1.5;
    const pagesBefore = doc.getNumberOfPages();
    ctx.checkPageBreak(h);
    if (doc.getNumberOfPages() !== pagesBefore) header();
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_DARK);
    doc.text(cells.date, COLS.date + 1, ctx.y);
    doc.text(docLines, COLS.doc, ctx.y);
    doc.text(partLines, COLS.part, ctx.y);
    doc.text(cells.debit, COLS.credit - 3, ctx.y, { align: "right" });
    doc.text(cells.credit, COLS.bal - 30, ctx.y, { align: "right" });
    doc.text(cells.bal, COLS.bal - 1, ctx.y, { align: "right" });
    ctx.y += h;
    doc.setDrawColor(225, 225, 225);
    doc.line(15, ctx.y - 2.5, 195, ctx.y - 2.5);
  };

  header();
  const money = (n: number) => (n ? formatCurrency(n) : "");
  line({ date: "", doc: "", part: "Opening balance", debit: "", credit: "", bal: formatCurrency(ledger.opening) }, true);
  if (!ledger.rows.length) {
    line({ date: "", doc: "", part: "No billing in this financial year", debit: "", credit: "", bal: "" });
  }
  for (const r of ledger.rows) {
    line({ date: shortDate(r.date), doc: r.document, part: r.particulars, debit: money(r.debit), credit: money(r.credit), bal: formatCurrency(r.balance) });
  }
  line({ date: "", doc: "", part: "Totals / closing balance", debit: formatCurrency(ledger.totalDebit), credit: formatCurrency(ledger.totalCredit), bal: formatCurrency(ledger.closing) }, true);

  ctx.checkPageBreak(14);
  ctx.y += 3;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(110, 110, 110);
  doc.text("Lists invoices and proforma invoices issued to you, and payments received. Cancelled and withdrawn documents are omitted.", 15, ctx.y);
  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}
