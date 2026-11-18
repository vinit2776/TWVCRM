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

export type SoaPeriod = "current" | "previous" | "both";

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

export interface SoaLedger {
  range: SoaRange;
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

export function soaRange(period: SoaPeriod, today: Date = new Date()): SoaRange {
  const cur = currentFyStartYear(today);
  const startYear = period === "current" ? cur : cur - 1;
  const endYear = period === "previous" ? cur - 1 : cur;
  const label = period === "both"
    ? `${fyLabel(cur - 1)} and ${fyLabel(cur)}`
    : fyLabel(startYear);
  return { from: `${startYear}-04-01`, to: `${endYear + 1}-03-31`, label };
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
        particulars: `Payment received (${mode})${ref}${tds > 0 ? ` incl. TDS ${tds}` : ""}`,
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
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { range, opening, rows, totalDebit, totalCredit, closing: balance };
}
