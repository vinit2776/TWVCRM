import jsPDF from "jspdf";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BRAND_DARK, BRAND_TEAL, addBrandHeader, addFooter, createPdfContext, formatCurrency, formatDate,
} from "@/lib/pdf-utils";
import {
  AGING_BUCKETS, buildLedger, chargeDescriptions, soaRange, type SoaLedger, type SoaPaymentInput, type SoaStatementInput,
} from "@/lib/statement-of-account";

const STATEMENT_COLUMNS =
  `id, status, statement_number, gst_invoice_number, total_amount, voided_at, proforma_sent_at, emailed_at, finalized_at, created_at, period_start, period_end, statement_type, line_items,
   usage_charges:usage_charges(description, is_waived),
   contract:contracts!billing_statements_contract_id_fkey(contract_number),
   booking:bookings!billing_statements_booking_id_fkey(booking_number),
   proposal:proposals!billing_statements_proposal_id_fkey(proposal_number),
   invoice:proforma_invoices!billing_statements_invoice_id_fkey(invoice_number)`;

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

  const stmts: SoaStatementInput[] = (statements || []).map((raw) => {
    const r = raw as unknown as SoaStatementInput & {
      line_items: Parameters<typeof chargeDescriptions>[0];
      usage_charges: Parameters<typeof chargeDescriptions>[1];
      contract: { contract_number: string } | null;
      booking: { booking_number: string } | null;
      proposal: { proposal_number: string } | null;
      invoice: { invoice_number: string } | null;
    };
    const reference = r.contract ? `Contract ${r.contract.contract_number}`
      : r.booking ? `Booking ${r.booking.booking_number}`
      : r.proposal ? `Proposal ${r.proposal.proposal_number}`
      : r.invoice ? `Invoice ${r.invoice.invoice_number}` : null;
    return { ...r, reference, charges: chargeDescriptions(r.line_items, r.usage_charges) };
  });
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
  // Name and address can run to several lines; advance by the lines actually drawn.
  const nameLines = doc.splitTextToSize(party.name, 180) as string[];
  doc.text(nameLines, 15, y);
  y += nameLines.length * 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  if (party.address) {
    const addressLines = doc.splitTextToSize(party.address, 180) as string[];
    doc.text(addressLines, 15, y);
    y += addressLines.length * 4.2 + 0.5;
  }
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
    const partLines = (cells.part.split("\n").flatMap((l) => doc.splitTextToSize(l, 50)) as string[]);
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

  if (ledger.outstanding.length) {
    ctx.checkPageBreak(40);
    ctx.y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...BRAND_TEAL);
    doc.text("Outstanding and aging", 15, ctx.y);
    ctx.y += 5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_DARK);
    doc.text(`Unpaid as at ${formatDate(ledger.asOf)}, counted from the invoice date.`, 15, ctx.y);
    ctx.y += 6;
    const heads = ["Document", "Type", "Contract / booking", "Invoice date", "Amount", "Paid", "Balance", "Days"];
    const xs = [16, 46, 66, 98, 132, 153, 176, 193];
    const outHeader = () => {
      doc.setFillColor(...BRAND_TEAL);
      doc.rect(15, ctx.y - 4.5, 180, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      heads.forEach((h, i) => doc.text(h, xs[i], ctx.y, { align: i >= 4 ? "right" : "left" }));
      ctx.y += 6;
    };
    outHeader();
    for (const o of ledger.outstanding) {
      const pages = doc.getNumberOfPages();
      ctx.checkPageBreak(7);
      if (doc.getNumberOfPages() !== pages) outHeader();
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...BRAND_DARK);
      const cells = [o.document, o.kind, o.reference || "-", shortDate(o.date), formatCurrency(o.amount), formatCurrency(o.paid), formatCurrency(o.balance), String(o.days)];
      cells.forEach((c, i) => doc.text(c, xs[i], ctx.y, { align: i >= 4 ? "right" : "left" }));
      ctx.y += 5.5;
    }
    ctx.checkPageBreak(24);
    ctx.y += 4;
    doc.setFont("helvetica", "bold");
    doc.text("Aging summary", 15, ctx.y);
    ctx.y += 5;
    AGING_BUCKETS.forEach((b, i) => {
      doc.setFont("helvetica", "normal");
      doc.text(b, 16, ctx.y);
      doc.text(formatCurrency(ledger.agingTotals[i]), 100, ctx.y, { align: "right" });
      ctx.y += 5;
    });
    doc.setFont("helvetica", "bold");
    doc.text("Total outstanding", 16, ctx.y);
    doc.text(formatCurrency(ledger.agingTotals.reduce((a, b) => a + b, 0)), 100, ctx.y, { align: "right" });
    ctx.y += 5;
  }

  // Pinned just above the footer band so it never spills onto a page of its own.
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(110, 110, 110);
  doc.text("Lists invoices and proforma invoices issued to you, and payments received. Cancelled and withdrawn documents are omitted.", 15, doc.internal.pageSize.getHeight() - 18);
  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}
