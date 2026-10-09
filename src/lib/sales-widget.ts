/**
 * Pure logic behind the dashboard Sales widget: which revenue stream a billing
 * statement belongs to, how much of it is collected / outstanding / overdue,
 * and the financial-year calendar.
 *
 * Everything here works on billing_statements (the receivables source of truth
 * the AR view and cash-aging also use), so the three tabs always reconcile:
 * invoiced = collected + outstanding. No I/O — safe to unit test.
 */

import { balanceDue, settlementAmount } from "@/lib/settlement";

export const SALES_STREAMS = ["rent", "vo", "bookings", "usage", "electricity", "adhoc"] as const;
export type SalesStream = (typeof SALES_STREAMS)[number];

export const SALES_STREAM_LABELS: Record<SalesStream, string> = {
  rent: "Rent",
  vo: "Virtual Office",
  bookings: "Bookings",
  usage: "Usage & services",
  electricity: "Electricity",
  adhoc: "Ad-hoc & other",
};

// Fixed hex (not theme tokens) so the same series reads the same in chart,
// legend and table, in light and dark.
export const SALES_STREAM_COLORS: Record<SalesStream, string> = {
  rent: "#534AB7",
  vo: "#1D9E75",
  bookings: "#D85A30",
  usage: "#BA7517",
  electricity: "#378ADD",
  adhoc: "#888780",
};

export type SalesMeasure = "invoiced" | "collected" | "outstanding";

// ─── Financial year (April → March, IST) ────────────────────────────────────

/** Start year of the financial year containing `ymd` (YYYY-MM-DD). FY 2026-27 → 2026. */
export function fyStartYearOf(ymd: string): number {
  const [y, m] = ymd.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

/** Today's date in IST as YYYY-MM-DD, independent of the server's timezone. */
export function todayIst(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export function fyLabel(fyStartYear: number): string {
  return `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
}

/** The 12 months of a financial year as YYYY-MM keys, April first. */
export function fyMonthKeys(fyStartYear: number): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const y = fyStartYear + (3 + i >= 12 ? 1 : 0);
    return `${y}-${String(m).padStart(2, "0")}`;
  });
}

export function fyDateRange(fyStartYear: number): { start: string; end: string } {
  return { start: `${fyStartYear}-04-01`, end: `${fyStartYear + 1}-03-31` };
}

// ─── Stream classification ──────────────────────────────────────────────────

export interface SalesStatementShape {
  statement_type: string | null;
  created_via: string | null;
  contract_id: string | null;
  booking_id: string | null;
  invoice_id: string | null;
  case_id: string | null;
  aggregator_id: string | null;
  subtotal: number | string | null;
  total_amount: number | string | null;
  tax_percentage: number | string | null;
  fixed_amount: number | string | null;
  booking_usage_amount: number | string | null;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Ex-GST value of a statement. Older rows may lack `subtotal`; derive it from the total. */
export function exGstAmount(s: Pick<SalesStatementShape, "subtotal" | "total_amount" | "tax_percentage">): number {
  const sub = num(s.subtotal);
  if (sub > 0) return sub;
  const total = num(s.total_amount);
  const rate = num(s.tax_percentage);
  return rate > 0 ? total / (1 + rate / 100) : total;
}

/**
 * Splits one statement's ex-GST value across streams. The parts always sum to
 * the statement's ex-GST value.
 *
 * Usage statements bundle meeting-room bookings with print/facility/ad-hoc
 * charges; booking_usage_amount carves the bookings out so they land in the
 * Bookings stream. A booking is billed exactly once (its usage_charge), so this
 * is the only place a contract customer's bookings are counted.
 */
export function classifyStatement(s: SalesStatementShape): { stream: SalesStream; amount: number }[] {
  const total = exGstAmount(s);
  if (total <= 0) return [];

  const type = s.statement_type ?? "";
  const only = (stream: SalesStream) => [{ stream, amount: round2(total) }];

  if (type.startsWith("vo_") || s.case_id || s.aggregator_id) return only("vo");
  if (type === "electricity") return only("electricity");
  if (type === "reimbursement" || s.invoice_id || s.created_via === "adhoc_invoice") return only("adhoc");
  if (s.booking_id && !s.contract_id) return only("bookings");

  if (type === "usage" || type === "combined") {
    const rentPart = type === "combined" ? Math.min(total, Math.max(0, num(s.fixed_amount))) : 0;
    const rest = total - rentPart;
    const bookingPart = Math.min(rest, Math.max(0, num(s.booking_usage_amount)));
    const usagePart = rest - bookingPart;
    return [
      { stream: "rent" as const, amount: round2(rentPart) },
      { stream: "bookings" as const, amount: round2(bookingPart) },
      { stream: "usage" as const, amount: round2(usagePart) },
    ].filter((p) => p.amount > 0);
  }

  // rent, proposal pro-rata invoices, and any untyped legacy statement
  return only("rent");
}

// ─── Settlement & overdue ───────────────────────────────────────────────────

/**
 * Fraction of the statement still unpaid, 0..1. Uses the shared settlement
 * definition (cash + TDS against the whole-rupee total) and treats a
 * written-off balance as closed, so the widget never disagrees with the AR view.
 */
export function unpaidFraction(
  totalAmount: number | string | null,
  paidCredit: number,
  writtenOff: number | string | null = 0
): number {
  const settle = settlementAmount(totalAmount);
  if (settle <= 0) return 0;
  const open = Math.max(0, balanceDue(totalAmount, paidCredit) - num(writtenOff));
  return Math.min(1, open / settle);
}

/** Due date that governs overdue: the early-GST override date if set, else the statement's due date. */
export function effectiveDueDate(s: { gst_invoice_due_date: string | null; due_date: string | null }): string | null {
  return s.gst_invoice_due_date ?? s.due_date ?? null;
}

/** Whole days past due as of `todayYmd`; null when there is no due date, <=0 when not yet due. */
export function daysPastDue(dueYmd: string | null, todayYmd: string): number | null {
  if (!dueYmd) return null;
  const a = Date.parse(`${dueYmd.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${todayYmd.slice(0, 10)}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

export const OVERDUE_BUCKETS = ["not_due", "d_1_30", "d_31_60", "d_60_plus", "no_due_date"] as const;
export type OverdueBucket = (typeof OVERDUE_BUCKETS)[number];

export function overdueBucket(days: number | null): OverdueBucket {
  if (days == null) return "no_due_date";
  if (days <= 0) return "not_due";
  if (days <= 30) return "d_1_30";
  if (days <= 60) return "d_31_60";
  return "d_60_plus";
}
