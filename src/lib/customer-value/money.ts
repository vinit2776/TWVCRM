/**
 * Customer Value tab — Money calculations.
 *
 * Pure functions: lifetime revenue and collection, payment promptness per
 * invoice, and the concessions ledger. See docs/customer-value-tab-spec.md,
 * sections 5.2 and 5.3.
 *
 * "Paid" always goes through `@/lib/settlement`: cash received plus the TDS the
 * customer deducted, against the whole-rupee invoice amount. Hand-rolling that
 * sum is how the receivables page once disagreed with the payment route.
 *
 * Due dates only exist on invoices generated after the receivables work, so
 * payment-timing figures are computed over the invoices that have one and the
 * result says how many that is — a customer is never judged on guessed dates.
 */

import { computeSettlement, paymentCredit } from "@/lib/settlement";
import {
  diffDays,
  diffMonths,
  isoToYmdIst,
  type JourneyRentStep,
} from "@/lib/customer-value/journey";

// ── Input shapes ────────────────────────────────────────────────────────

export interface MoneyStatementRow {
  id: string;
  statement_number: string | null;
  gst_invoice_number: string | null;
  statement_type: string | null;
  period_start: string;
  period_end: string;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
  status: string;
  due_date: string | null;
  reminder_count: number | null;
}

export interface MoneyPaymentRow {
  billing_statement_id: string;
  amount: number | string | null;
  tds_amount: number | string | null;
  /** `YYYY-MM-DD` */
  payment_date: string | null;
  created_at: string;
}

export interface MoneyConcessionInput {
  rentWaivers: Array<{
    contract_id: string;
    waived_month: string;
    reason: string | null;
    revoked_at: string | null;
    /** giveaway | billed_elsewhere | unknown (contract_rent_waivers.waiver_kind, migration 00615). */
    waiver_kind: string | null;
  }>;
  moratoriums: Array<{
    contract_id: string;
    moratorium_month: string;
    reason: string | null;
    status: string;
    overridden_at: string | null;
  }>;
  bookingWaivers: Array<{
    waiver_type: string;
    waiver_amount: number | string | null;
    status: string;
    approved_at: string | null;
    created_at: string;
    note: string | null;
  }>;
  refunds: Array<{
    amount_requested: number | string | null;
    status: string;
    processed_at: string | null;
    requested_at: string;
    reason: string | null;
  }>;
  creditNotes: Array<{
    credit_note_amount: number | string | null;
    credit_note_date: string | null;
    credit_note_number: string | null;
    reason: string | null;
    superseded_by: string | null;
  }>;
  /** contract id → contract number, for labels. */
  contractNumbers: Record<string, string>;
}

export interface MoneyInput {
  statements: MoneyStatementRow[];
  payments: MoneyPaymentRow[];
  concessions: MoneyConcessionInput;
  rentSteps: JourneyRentStep[];
  /** `YYYY-MM-DD` in IST. */
  today: string;
}

// ── Output shapes ───────────────────────────────────────────────────────

export interface MoneyInvoice {
  id: string;
  reference: string;
  type: string | null;
  periodStart: string;
  periodEnd: string;
  total: number;
  due: string | null;
  /** Date the invoice became fully settled, or null while it is not. */
  paidOn: string | null;
  /** Days after the due date it was settled (negative = early). Null when not measurable. */
  daysLate: number | null;
  /** Days past due while still unpaid. Null when not overdue. */
  daysOverdue: number | null;
  balance: number;
  /** Credit received beyond the invoice amount (a customer credit), else 0. */
  overpaid: number;
  paymentStatus: "unpaid" | "partially_paid" | "paid";
  reminders: number;
}

export type ConcessionKind = "rent_waiver" | "moratorium" | "booking_waiver" | "refund" | "credit_note";

export interface MoneyConcession {
  kind: ConcessionKind;
  /** `YYYY-MM-DD` */
  date: string;
  label: string;
  detail: string | null;
  /** Rupees, or null when it cannot be priced. */
  amount: number | null;
  /** Counts toward the totals. Pending and reversed items are listed but not counted. */
  counted: boolean;
  /** Why an item is not counted. */
  note: string | null;
}

export interface Money {
  lifetime: {
    issuedCount: number;
    invoicedExGst: number;
    invoicedInclGst: number;
    cashReceived: number;
    tdsDeducted: number;
    outstanding: number;
    /** Total credit received beyond invoice amounts, and how many invoices it sits on. */
    overpaid: number;
    overpaidCount: number;
    firstInvoiceDate: string | null;
    monthsSpan: number;
    avgMonthlyExGst: number;
  };
  timing: {
    issuedCount: number;
    withDueDateCount: number;
    measuredCount: number;
    onTimeCount: number;
    onTimePct: number | null;
    avgDaysLate: number | null;
    worstDaysLate: number | null;
    overdueNow: { count: number; amount: number; maxDays: number };
    remindedCount: number;
    totalReminders: number;
  };
  invoices: MoneyInvoice[];
  concessions: {
    entries: MoneyConcession[];
    /**
     * Counted concessions by kind, and their sum. A rent waiver counts only when
     * it was marked as given to the customer. One marked "billed outside the
     * CRM" gave nothing away and is listed without a price. One not yet
     * classified (made before waiver_kind existed) might be either, so it stays
     * out of the sum and is priced separately in `unbilledRent`.
     */
    totals: Record<ConcessionKind, number> & { all: number; unbilledRent: number };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Only finalized and exported statements are real invoices. Drafts were never
 * sent, voided statements were cancelled, and discarded ones are usage drafts
 * that were thrown away before anything went out. A positive list, so a status
 * added later is left out until someone decides it counts as revenue.
 */
const ISSUED_STATUSES = new Set(["finalized", "exported"]);

export function isIssued(status: string): boolean {
  return ISSUED_STATUSES.has(status);
}

/**
 * The date a statement became fully settled: the date of the payment that took
 * the running credit (cash + TDS) to the settlement amount. Null if it never did.
 */
export function settledOn(
  payments: MoneyPaymentRow[],
  statementTotal: number | string | null
): string | null {
  const target = Math.round(num(statementTotal));
  if (target <= 0) return null;
  const ordered = [...payments].sort((a, b) => {
    const ad = a.payment_date ?? a.created_at.slice(0, 10);
    const bd = b.payment_date ?? b.created_at.slice(0, 10);
    return ad < bd ? -1 : ad > bd ? 1 : a.created_at < b.created_at ? -1 : 1;
  });
  let running = 0;
  for (const p of ordered) {
    running += paymentCredit(p);
    if (running >= target) return p.payment_date ?? isoToYmdIst(p.created_at);
  }
  return null;
}

/** Monthly rent a contract charged in a given month, from the rent steps. */
export function rentInMonth(steps: JourneyRentStep[], contractId: string, monthStart: string): number | null {
  const own = steps.find((s) => s.contractId === contractId && s.from <= monthStart && monthStart <= s.to);
  return own ? own.monthlyRent : null;
}

function monthLabel(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const EMPTY_KIND_TOTALS: Record<ConcessionKind, number> = {
  rent_waiver: 0,
  moratorium: 0,
  booking_waiver: 0,
  refund: 0,
  credit_note: 0,
};

// ── Main ────────────────────────────────────────────────────────────────

export function buildMoney(input: MoneyInput): Money {
  const { today } = input;
  const issued = input.statements.filter((s) => isIssued(s.status));

  const paymentsByStatement = new Map<string, MoneyPaymentRow[]>();
  for (const p of input.payments) {
    const list = paymentsByStatement.get(p.billing_statement_id) ?? [];
    list.push(p);
    paymentsByStatement.set(p.billing_statement_id, list);
  }

  const invoices: MoneyInvoice[] = issued.map((s) => {
    const payments = paymentsByStatement.get(s.id) ?? [];
    const settlement = computeSettlement(s.total_amount, payments);
    const paidOn = settlement.paymentStatus === "paid" ? settledOn(payments, s.total_amount) : null;
    const due = s.due_date;
    const daysLate = due && paidOn ? diffDays(due, paidOn) : null;
    const daysOverdue =
      due && settlement.paymentStatus !== "paid" && today > due ? diffDays(due, today) : null;
    return {
      id: s.id,
      reference: s.gst_invoice_number || s.statement_number || "Draft",
      type: s.statement_type,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      total: num(s.total_amount),
      due,
      paidOn,
      daysLate,
      daysOverdue,
      balance: settlement.balanceDue,
      overpaid: Math.max(0, settlement.totalPaid - settlement.settlementAmount),
      paymentStatus: settlement.paymentStatus,
      reminders: s.reminder_count ?? 0,
    };
  });
  invoices.sort((a, b) => (a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : 0));

  // Lifetime
  const firstInvoiceDate = issued.reduce<string | null>(
    (min, s) => (min === null || s.period_start < min ? s.period_start : min),
    null
  );
  const invoicedExGst = issued.reduce((sum, s) => sum + num(s.subtotal), 0);
  const issuedIds = new Set(issued.map((s) => s.id));
  const issuedPayments = input.payments.filter((p) => issuedIds.has(p.billing_statement_id));
  const monthsSpan = firstInvoiceDate ? Math.max(1, diffMonths(firstInvoiceDate, today) + 1) : 1;

  // Timing
  const measured = invoices.filter((i) => i.daysLate !== null);
  const onTime = measured.filter((i) => (i.daysLate as number) <= 0);
  const overdue = invoices.filter((i) => i.daysOverdue !== null);
  const lateValues = measured.map((i) => i.daysLate as number);

  // Concessions
  const entries: MoneyConcession[] = [];
  const c = input.concessions;

  for (const w of c.rentWaivers) {
    if (w.revoked_at) continue;
    const waiverKind =
      w.waiver_kind === "giveaway" || w.waiver_kind === "billed_elsewhere" ? w.waiver_kind : "unknown";
    const rent = rentInMonth(input.rentSteps, w.contract_id, w.waived_month);
    const detail = [c.contractNumbers[w.contract_id], w.reason].filter(Boolean).join(" · ") || null;

    if (waiverKind === "giveaway") {
      entries.push({
        kind: "rent_waiver",
        date: w.waived_month,
        label: `Rent waived for ${monthLabel(w.waived_month)}`,
        detail,
        amount: rent,
        counted: true,
        note: rent === null ? "Rent for that month could not be determined" : null,
      });
    } else if (waiverKind === "billed_elsewhere") {
      entries.push({
        kind: "rent_waiver",
        date: w.waived_month,
        label: `Billed outside the CRM: ${monthLabel(w.waived_month)}`,
        detail,
        amount: null,
        counted: false,
        note: "Billed outside the CRM, so no rent was given away",
      });
    } else {
      entries.push({
        kind: "rent_waiver",
        date: w.waived_month,
        label: `Not billed in the CRM: ${monthLabel(w.waived_month)}`,
        detail,
        amount: rent,
        counted: false,
        note:
          rent === null
            ? "Rent for that month could not be determined"
            : "Not classified: may have been billed elsewhere, so not counted",
      });
    }
  }
  for (const m of c.moratoriums) {
    if (m.status === "rejected") continue;
    const approved = m.status === "approved";
    const billedAnyway = approved && Boolean(m.overridden_at);
    const amount = rentInMonth(input.rentSteps, m.contract_id, m.moratorium_month);
    entries.push({
      kind: "moratorium",
      date: m.moratorium_month,
      label: `Billing skipped for ${monthLabel(m.moratorium_month)}`,
      detail: [c.contractNumbers[m.contract_id], m.reason].filter(Boolean).join(" · ") || null,
      amount,
      counted: approved && !billedAnyway,
      note: billedAnyway ? "Billed anyway after approval" : approved ? null : "Awaiting approval",
    });
  }
  for (const b of c.bookingWaivers) {
    if (b.status === "denied" || b.status === "expired") continue;
    const approved = b.status === "approved";
    entries.push({
      kind: "booking_waiver",
      date: isoToYmdIst(b.approved_at ?? b.created_at),
      label: `Booking charge waived (${b.waiver_type})`,
      detail: b.note,
      amount: num(b.waiver_amount),
      counted: approved,
      note: approved ? null : "Awaiting approval",
    });
  }
  for (const r of c.refunds) {
    if (r.status === "rejected") continue;
    const processed = r.status === "processed";
    entries.push({
      kind: "refund",
      date: isoToYmdIst(r.processed_at ?? r.requested_at),
      label: "Booking refund",
      detail: r.reason,
      amount: num(r.amount_requested),
      counted: processed,
      note: processed ? null : "Not paid out yet",
    });
  }
  for (const n of c.creditNotes) {
    if (n.superseded_by) continue;
    entries.push({
      kind: "credit_note",
      date: n.credit_note_date ?? "",
      label: `Credit note${n.credit_note_number ? ` ${n.credit_note_number}` : ""}`,
      detail: n.reason,
      amount: num(n.credit_note_amount),
      counted: true,
      note: null,
    });
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const totals = { ...EMPTY_KIND_TOTALS, all: 0, unbilledRent: 0 };
  for (const e of entries) {
    if (e.amount === null) continue;
    // A rent waiver that is not counted is an unclassified one: price it, but
    // keep it out of the concession total.
    if (e.kind === "rent_waiver" && !e.counted) {
      totals.unbilledRent += e.amount;
      continue;
    }
    if (!e.counted) continue;
    totals[e.kind] += e.amount;
    totals.all += e.amount;
  }

  return {
    lifetime: {
      issuedCount: issued.length,
      invoicedExGst,
      invoicedInclGst: issued.reduce((sum, s) => sum + num(s.total_amount), 0),
      cashReceived: issuedPayments.reduce((sum, p) => sum + num(p.amount), 0),
      tdsDeducted: issuedPayments.reduce((sum, p) => sum + num(p.tds_amount), 0),
      outstanding: invoices.reduce((sum, i) => sum + i.balance, 0),
      overpaid: invoices.reduce((sum, i) => sum + i.overpaid, 0),
      overpaidCount: invoices.filter((i) => i.overpaid > 0).length,
      firstInvoiceDate,
      monthsSpan,
      avgMonthlyExGst: invoicedExGst / monthsSpan,
    },
    timing: {
      issuedCount: issued.length,
      withDueDateCount: issued.filter((s) => s.due_date).length,
      measuredCount: measured.length,
      onTimeCount: onTime.length,
      onTimePct: measured.length > 0 ? (onTime.length / measured.length) * 100 : null,
      avgDaysLate:
        lateValues.length > 0 ? lateValues.reduce((a, b) => a + b, 0) / lateValues.length : null,
      worstDaysLate: lateValues.length > 0 ? Math.max(...lateValues) : null,
      overdueNow: {
        count: overdue.length,
        amount: overdue.reduce((sum, i) => sum + i.balance, 0),
        maxDays: overdue.reduce((max, i) => Math.max(max, i.daysOverdue as number), 0),
      },
      remindedCount: issued.filter((s) => (s.reminder_count ?? 0) > 0).length,
      totalReminders: issued.reduce((sum, s) => sum + (s.reminder_count ?? 0), 0),
    },
    invoices,
    concessions: { entries, totals },
  };
}
