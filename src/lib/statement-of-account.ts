/**
 * Statement of account for a customer: a running ledger of what we billed
 * (PIs and GST invoices) and what they paid, over one or two Indian financial
 * years. Pure module — the loader and the PDF live in
 * statement-of-account-server.ts.
 *
 * Only documents the customer actually received count: voided, discarded,
 * draft and held-back statements are left out, so the balance matches what
 * they have seen.
 */

import { paymentCredit, settlementAmount } from "@/lib/settlement";

export interface SoaRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  label: string;
}

/** Statement states that never reached the customer (or were pulled back). */
const EXCLUDED_STATUSES = ["draft", "voided", "discarded"];

export interface SoaStatementInput {
  id: string;
  status: string;
  statement_number: string;
  gst_invoice_number: string | null;
  total_amount: number | string | null;
  voided_at: string | null;
  proforma_sent_at: string | null;
  emailed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
  statement_type: string | null;
  invoice_number?: string | null;
}

export interface SoaPaymentInput {
  billing_statement_id: string;
  amount: number | string | null;
  tds_amount: number | string | null;
  payment_date: string;
  payment_mode: string | null;
  payment_reference: string | null;
}

export interface SoaRow {
  date: string;
  /** Document number(s) shown to the customer. */
  document: string;
  particulars: string;
  debit: number;
  credit: number;
  balance: number;
}

export const AGING_BUCKETS = ["0-30 days", "31-60 days", "61-90 days", "Over 90 days"] as const;

export interface SoaOutstanding {
  date: string;
  document: string;
  /** "Pending PI" until a GST invoice exists, then "GST invoice". */
  kind: "Pending PI" | "GST invoice";
  amount: number;
  paid: number;
  balance: number;
  /** Days since the invoice date, as at `asOf`. */
  days: number;
  bucket: (typeof AGING_BUCKETS)[number];
}

export interface SoaLedger {
  range: SoaRange;
  /** The date aging is measured to: today, or the FY end for a past year. */
  asOf: string;
  outstanding: SoaOutstanding[];
  /** Outstanding balance per AGING_BUCKETS entry. */
  agingTotals: number[];
  opening: number;
  rows: SoaRow[];
  totalDebit: number;
  totalCredit: number;
  closing: number;
}

const istDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** The FY (April–March) containing `today`, as its starting calendar year. */
export function currentFyStartYear(today: Date = new Date()): number {
  const [y, m] = istDate(today.toISOString()).split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

const fyLabel = (startYear: number) =>
  `FY ${startYear}-${String(startYear + 1).slice(-2)}`;

/** One Indian financial year (April–March), named by the calendar year it starts in. */
export function soaRange(startYear: number): SoaRange {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31`, label: fyLabel(startYear) };
}

/** FYs offered in the picker, newest first, starting with the current one. */
export const SOA_FY_COUNT = 6;
export function soaFyOptions(today: Date = new Date()): SoaRange[] {
  const cur = currentFyStartYear(today);
  return Array.from({ length: SOA_FY_COUNT }, (_, i) => soaRange(cur - i));
}

/**
 * Whether the customer was ever given this statement. Money already received
 * against it counts too: a payment recorded on a statement with no "sent"
 * stamp is still a real bill and dropping it would drop the payment.
 */
export function isCustomerFacing(s: SoaStatementInput, hasPayment = false): boolean {
  if (EXCLUDED_STATUSES.includes(s.status) || s.voided_at) return false;
  return !!(s.proforma_sent_at || s.emailed_at || s.gst_invoice_number || hasPayment);
}

const statementDate = (s: SoaStatementInput): string =>
  istDate(s.proforma_sent_at || s.finalized_at || s.created_at);

function describeStatement(s: SoaStatementInput): { document: string; particulars: string } {
  const gst = s.gst_invoice_number;
  const document = gst ? `${gst} (PI ${s.statement_number})` : `PI ${s.statement_number}`;
  const particulars = s.period_start && s.period_end && s.statement_type !== "vo_case"
    ? `Charges for ${s.period_start} to ${s.period_end}`
    : s.invoice_number ? `Invoice ${s.invoice_number}` : "Charges";
  return { document: gst ? document : `${document} (proforma)`, particulars };
}

export function buildLedger(
  statements: SoaStatementInput[],
  payments: SoaPaymentInput[],
  range: SoaRange,
  today: Date = new Date(),
): SoaLedger {
  const paidIds = new Set(payments.map((p) => p.billing_statement_id));
  const live = statements.filter((s) => isCustomerFacing(s, paidIds.has(s.id)));
  const liveIds = new Set(live.map((s) => s.id));
  const byId = new Map(live.map((s) => [s.id, s]));

  type Entry = { date: string; order: number; row: Omit<SoaRow, "balance"> };
  const entries: Entry[] = [];
  for (const s of live) {
    const { document, particulars } = describeStatement(s);
    entries.push({
      date: statementDate(s), order: 0,
      row: { date: statementDate(s), document, particulars, debit: settlementAmount(s.total_amount), credit: 0 },
    });
  }
  for (const p of payments) {
    if (!liveIds.has(p.billing_statement_id)) continue;
    const s = byId.get(p.billing_statement_id)!;
    const tds = Number(p.tds_amount || 0);
    const mode = (p.payment_mode || "payment").replace(/_/g, " ");
    const ref = p.payment_reference ? ` · ref ${p.payment_reference}` : "";
    const date = p.payment_date.slice(0, 10);
    entries.push({
      date, order: 1,
      row: {
        date,
        document: describeStatement(s).document.split(" (")[0],
        particulars: `Payment received (${mode})${ref}${tds > 0 ? ` incl. TDS Rs. ${tds.toLocaleString("en-IN")}` : ""}`,
        debit: 0, credit: paymentCredit(p),
      },
    });
  }
  // Invoice before payment on the same day, so a same-day payment never
  // shows the balance dipping below zero.
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  let opening = 0;
  const inRange: Entry[] = [];
  for (const e of entries) {
    if (e.date < range.from) opening += e.row.debit - e.row.credit;
    else if (e.date <= range.to) inRange.push(e);
  }

  let balance = opening;
  const rows: SoaRow[] = inRange.map((e) => {
    balance += e.row.debit - e.row.credit;
    return { ...e.row, balance };
  });
  const asOf = istDate(today.toISOString()) < range.to ? istDate(today.toISOString()) : range.to;
  const outstanding: SoaOutstanding[] = [];
  const agingTotals = AGING_BUCKETS.map(() => 0);
  for (const st of live) {
    const date = statementDate(st);
    if (date > asOf) continue;
    const amount = settlementAmount(st.total_amount);
    const paid = payments
      .filter((p) => p.billing_statement_id === st.id && p.payment_date.slice(0, 10) <= asOf)
      .reduce((sum, p) => sum + paymentCredit(p), 0);
    const balance = amount - paid;
    if (balance <= 0) continue;
    const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400e3);
    const idx = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    agingTotals[idx] += balance;
    outstanding.push({
      date, document: describeStatement(st).document.split(" (")[0],
      kind: st.gst_invoice_number ? "GST invoice" : "Pending PI",
      amount, paid, balance, days, bucket: AGING_BUCKETS[idx],
    });
  }
  outstanding.sort((a, b) => b.days - a.days);

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { range, asOf, outstanding, agingTotals, opening, rows, totalDebit, totalCredit, closing: balance };
}
