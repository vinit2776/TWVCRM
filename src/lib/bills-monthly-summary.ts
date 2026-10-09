/**
 * Month-by-month rollup of a set of vendor bills, used by the Vendor Bills
 * page when it is filtered to a single vendor. Pure so the arithmetic is
 * unit-tested; the route supplies the bills and the open-query counts.
 */

export interface MonthlyBillInput {
  id: string;
  invoice_date: string | null;
  total_amount: number | string;
  payment_status: string;
  approval_status?: string | null;
}

export interface MonthSummary {
  /** YYYY-MM, or "none" for bills with no invoice date. */
  month: string;
  billCount: number;
  total: number;
  paid: number;
  partiallyPaid: number;
  unpaid: number;
  /** Rejected bills are never owed, so they sit outside paid/unpaid. */
  rejected: number;
  openQueries: number;
}

export interface BillsMonthlySummary {
  /** Oldest first, so the chart reads left to right. */
  months: MonthSummary[];
  billCount: number;
  total: number;
  paid: number;
  partiallyPaid: number;
  unpaid: number;
  rejected: number;
  openQueries: number;
  billsWithOpenQueries: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function monthKey(invoiceDate: string | null): string {
  return invoiceDate ? invoiceDate.slice(0, 7) : "none";
}

export function summarizeBillsByMonth(
  bills: MonthlyBillInput[],
  openQueriesByBill: Map<string, number>,
): BillsMonthlySummary {
  const byMonth = new Map<string, MonthSummary>();

  for (const bill of bills) {
    const key = monthKey(bill.invoice_date);
    const m = byMonth.get(key) ?? {
      month: key, billCount: 0, total: 0, paid: 0, partiallyPaid: 0, unpaid: 0, rejected: 0, openQueries: 0,
    };
    const amount = Number(bill.total_amount) || 0;
    m.billCount += 1;
    m.total += amount;
    if (bill.approval_status === "rejected") m.rejected += amount;
    else if (bill.payment_status === "paid") m.paid += amount;
    else if (bill.payment_status === "partially_paid") m.partiallyPaid += amount;
    else m.unpaid += amount;
    m.openQueries += openQueriesByBill.get(bill.id) ?? 0;
    byMonth.set(key, m);
  }

  const months = Array.from(byMonth.values())
    .map((m) => ({
      ...m,
      total: round2(m.total),
      paid: round2(m.paid),
      partiallyPaid: round2(m.partiallyPaid),
      unpaid: round2(m.unpaid),
      rejected: round2(m.rejected),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const sum = (pick: (m: MonthSummary) => number) => round2(months.reduce((s, m) => s + pick(m), 0));
  const billIds = new Set(bills.map((b) => b.id));

  return {
    months,
    billCount: bills.length,
    total: sum((m) => m.total),
    paid: sum((m) => m.paid),
    partiallyPaid: sum((m) => m.partiallyPaid),
    unpaid: sum((m) => m.unpaid),
    rejected: sum((m) => m.rejected),
    openQueries: months.reduce((s, m) => s + m.openQueries, 0),
    billsWithOpenQueries: Array.from(openQueriesByBill.entries()).filter(([id, n]) => n > 0 && billIds.has(id)).length,
  };
}
