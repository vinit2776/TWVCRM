/**
 * The single definition of "paid" for billing statements.
 *
 * A statement settles on (cash received + TDS deducted by the customer),
 * compared against the whole-rupee invoice amount. Every consumer that
 * computes paid-to-date or outstanding balance from billing_payments MUST
 * go through these helpers — hand-rolling the sum is how the receivables
 * page and the payment route ended up with two conflicting definitions of
 * "paid" (TDS-bearing statements showed inflated balances in AR/aging).
 *
 * Pure module — safe to import from server routes and client components.
 */

export interface SettlementPayment {
  amount: number | string | null;
  tds_amount?: number | string | null;
}

export type SettlementPaymentStatus = "unpaid" | "partially_paid" | "paid";

/**
 * What a single payment row credits toward settlement: cash received (net)
 * plus the customer's TDS deduction. A TDS-short payment still closes the
 * invoice — the TDS portion is recovered from the department, not the customer.
 */
export function paymentCredit(p: SettlementPayment): number {
  return Number(p.amount || 0) + Number(p.tds_amount || 0);
}

/** Total credited toward settlement across all payments on a statement. */
export function totalPaid(payments: SettlementPayment[] | null | undefined): number {
  return (payments || []).reduce((s, p) => s + paymentCredit(p), 0);
}

/**
 * The amount a statement settles against: the whole-rupee total, not the raw
 * (possibly paisa-bearing) figure. Tally GST invoices are always rounded to
 * the nearest rupee, so the customer only ever pays the rounded figure —
 * comparing against the raw total would leave the statement permanently
 * short by a few paise and never flip to "paid". Mirrors the tolerance used
 * in the Tally inbox discrepancy check and the GST invoice upload validation.
 */
export function settlementAmount(statementTotal: number | string | null): number {
  return Math.round(Number(statementTotal || 0));
}

/** Outstanding balance given a paid-to-date figure (from totalPaid / paymentCredit sums). */
export function balanceDue(statementTotal: number | string | null, paidToDate: number): number {
  return Math.max(0, settlementAmount(statementTotal) - paidToDate);
}

/** Payment status given a paid-to-date figure. */
export function settlementStatus(
  statementTotal: number | string | null,
  paidToDate: number
): SettlementPaymentStatus {
  if (paidToDate >= settlementAmount(statementTotal)) return "paid";
  if (paidToDate > 0) return "partially_paid";
  return "unpaid";
}

/** One-shot settlement computation from a statement total and its payment rows. */
export function computeSettlement(
  statementTotal: number | string | null,
  payments: SettlementPayment[] | null | undefined
): {
  totalPaid: number;
  settlementAmount: number;
  balanceDue: number;
  paymentStatus: SettlementPaymentStatus;
} {
  const paid = totalPaid(payments);
  return {
    totalPaid: paid,
    settlementAmount: settlementAmount(statementTotal),
    balanceDue: balanceDue(statementTotal, paid),
    paymentStatus: settlementStatus(statementTotal, paid),
  };
}
