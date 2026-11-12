/**
 * Customer Value — monthly metrics builder.
 *
 * Turns one customer's raw rows (contracts, invoices, payments, reminders,
 * bookings, tickets, door events) into the monthly figures the scoring library
 * reads (`MonthlyMetrics`). See docs/plans/customer-value-phase2.md, sections 3
 * and 5.
 *
 * The one rule that shapes everything: **every figure is computed as it was
 * known on `asOf`.** An invoice paid in October is unpaid in a row built as of
 * September; a reminder sent next month does not exist yet; a ticket reported
 * after `asOf` is invisible. That is what lets a backfill reproduce the score a
 * customer would have had at each month end, instead of grading history with
 * hindsight.
 *
 * Pure module: no database, no clock. Dates are `YYYY-MM-DD` (IST) strings.
 */

import { computeSettlement } from "@/lib/settlement";
import {
  contractRan,
  diffDays,
  effectiveEnd,
  rentStepsForContract,
  type JourneyContractRow,
} from "@/lib/customer-value/journey";
import { isIssued, settledOn, type MoneyPaymentRow } from "@/lib/customer-value/money";
import type { MonthlyMetrics } from "@/lib/customer-value/scoring-pillars";

// ── Raw input shapes ────────────────────────────────────────────────────

export interface RawStatement {
  id: string;
  period_start: string;
  subtotal: number | string | null;
  total_amount: number | string | null;
  status: string;
  due_date: string | null;
  /** When it was issued, as an ISO timestamp. Null on older rows; treated as already issued. */
  finalized_at: string | null;
}

export interface RawReminder {
  billing_statement_id: string;
  sent_at: string;
  status: string;
}

export interface RawBooking {
  /** `YYYY-MM-DD` */
  booking_date: string;
  status: string;
}

export interface RawDoorEvent {
  /** `YYYY-MM-DD`, IST. */
  date: string;
  /** Stable id of the person, so one person swiping twice counts once. */
  person: string;
  /** "IN", "OUT" or "DENIED". Only "IN" counts as presence. */
  direction: string;
}

export interface RawTicket {
  id: string;
  /** ISO timestamp. */
  reported_at: string;
  sla_breached: boolean | null;
  reopen_count: number | null;
  satisfaction_rating: number | null;
}

/** A concession that counts (already filtered), dated to the month it relates to. */
export interface RawConcession {
  date: string;
  amount: number;
}

export interface RawDoorData {
  events: RawDoorEvent[];
  /** Dates on which the center recorded any door activity, i.e. days it was open. */
  centerActiveDays: string[];
  /**
   * False when this customer has no door events in the lookback, which usually
   * means their people are not enrolled rather than that nobody came. Seats used
   * is then unknown, never zero.
   */
  mapped: boolean;
}

export interface CustomerRaw {
  contracts: JourneyContractRow[];
  statements: RawStatement[];
  payments: MoneyPaymentRow[];
  reminders: RawReminder[];
  concessions: RawConcession[];
  bookings: RawBooking[];
  /** Tickets already tied to THIS customer (see ticket-linking.ts). */
  tickets: RawTicket[];
  /** The center's tickets that could not be tied to anyone, by month key `YYYY-MM-01`. */
  ticketsUnlinkedByMonth?: Record<string, number>;
  /** Null when billing queries could not be counted at all (table absent). */
  billingQueries: Array<{ created_at: string }> | null;
  /** Null when the center has no door devices. */
  door: RawDoorData | null;
}

export interface DataFlags {
  /** Some invoices of this month had no due date, so their timing could not be judged. */
  invoices_without_due_date: number;
  /** "mapped" = door data used; "unmapped" = center has door data but this customer has none; "none" = no devices. */
  door: "mapped" | "unmapped" | "none";
  billing_queries_available: boolean;
  /** The month had not ended as of `asOf`. */
  partial_month: boolean;
}

/** One month of figures: what the scorer reads, plus the extras the snapshot table stores. */
export interface MonthlyRow extends MonthlyMetrics {
  tickets_unlinked: number;
  data_flags: DataFlags;
}

/** Booking statuses that are not engagement. */
const NON_ENGAGEMENT_BOOKING_STATUSES = new Set(["cancelled", "no_show", "rejected"]);

// ── Month arithmetic ────────────────────────────────────────────────────

/** `YYYY-MM-01` for the month containing `ymd`. */
export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** Last day of the month containing `ymd`, `YYYY-MM-DD`. */
export function monthEnd(ymd: string): string {
  const [y, m] = ymd.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export function daysInMonth(ymd: string): number {
  return Number(monthEnd(ymd).slice(8, 10));
}

/** Every `YYYY-MM-01` from the month of `from` to the month of `to`, inclusive. Empty if `to` is earlier. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Inclusive days two date ranges share, 0 if they do not overlap. */
function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return from > to ? 0 : diffDays(from, to) + 1;
}

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The IST date of an ISO timestamp. */
function istDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

function paymentDate(p: MoneyPaymentRow): string {
  return p.payment_date ?? istDate(p.created_at);
}

// ── Builder ─────────────────────────────────────────────────────────────

/**
 * Monthly figures for one customer, from their first activity to `asOf`, as
 * known on `asOf`. Empty when the customer has no contract that ever ran and no
 * invoice.
 */
export function buildMonthlyRows(raw: CustomerRaw, asOf: string): MonthlyRow[] {
  const ran = raw.contracts.filter(contractRan);
  const issuedStatements = raw.statements.filter(
    (s) => isIssued(s.status) && (s.finalized_at === null || istDate(s.finalized_at) <= asOf)
  );

  const firstDates = [
    ...ran.map((c) => c.start_date),
    ...issuedStatements.map((s) => s.period_start),
  ].filter((d) => d <= asOf);
  if (firstDates.length === 0) return [];
  const first = firstDates.reduce((min, d) => (d < min ? d : min));

  // Payments known as of asOf, grouped by statement.
  const knownPayments = raw.payments.filter((p) => paymentDate(p) <= asOf);
  const paymentsByStatement = new Map<string, MoneyPaymentRow[]>();
  for (const p of knownPayments) {
    const list = paymentsByStatement.get(p.billing_statement_id) ?? [];
    list.push(p);
    paymentsByStatement.set(p.billing_statement_id, list);
  }

  const rentSteps = ran.flatMap(rentStepsForContract);

  const rows: MonthlyRow[] = [];
  for (const month of monthRange(first, asOf)) {
    const mEnd = monthEnd(month);
    const evalDate = mEnd < asOf ? mEnd : asOf;
    const days = daysInMonth(month);

    // ── Invoices ─────────────────────────────────────────────────────
    const revenue = issuedStatements
      .filter((s) => monthStart(s.period_start) === month)
      .reduce((sum, s) => sum + num(s.subtotal), 0);

    // Timing is attributed to the month the invoice fell due (or, for older
    // invoices with no due date, the month of its period).
    const dueThisMonth = issuedStatements.filter((s) => monthStart(s.due_date ?? s.period_start) === month);
    let measured = 0;
    let onTime = 0;
    let lateDaysTotal = 0;
    let withoutDueDate = 0;
    for (const s of dueThisMonth) {
      if (!s.due_date) {
        withoutDueDate += 1;
        continue;
      }
      const pays = paymentsByStatement.get(s.id) ?? [];
      if (computeSettlement(s.total_amount, pays).paymentStatus !== "paid") continue;
      const paidOn = settledOn(pays, s.total_amount);
      if (!paidOn) continue;
      const late = diffDays(s.due_date, paidOn);
      measured += 1;
      lateDaysTotal += late;
      if (late <= 0) onTime += 1;
    }

    // Overdue is judged at the end of this month, across every invoice that
    // was already due by then, whichever month it belongs to.
    let overdueAmount = 0;
    let maxDaysOverdue = 0;
    for (const s of issuedStatements) {
      if (!s.due_date || s.due_date >= evalDate) continue;
      const pays = (paymentsByStatement.get(s.id) ?? []).filter((p) => paymentDate(p) <= evalDate);
      const settlement = computeSettlement(s.total_amount, pays);
      if (settlement.balanceDue <= 0) continue;
      overdueAmount += settlement.balanceDue;
      maxDaysOverdue = Math.max(maxDaysOverdue, diffDays(s.due_date, evalDate));
    }

    const reminders = raw.reminders.filter(
      (r) => r.status !== "failed" && monthStart(istDate(r.sent_at)) === month && istDate(r.sent_at) <= asOf
    ).length;

    const concessions = raw.concessions
      .filter((c) => monthStart(c.date) === month && c.date <= asOf)
      .reduce((sum, c) => sum + c.amount, 0);

    // ── Seats and rent ───────────────────────────────────────────────
    let seatDays = 0;
    let rentDays = 0;
    for (const c of ran) {
      const overlap = overlapDays(c.start_date, effectiveEnd(c), month, mEnd);
      if (overlap > 0) seatDays += (num(c.seats) * overlap) / days;
    }
    for (const step of rentSteps) {
      const overlap = overlapDays(step.from, step.to, month, mEnd);
      if (overlap > 0) rentDays += (step.monthlyRent * overlap) / days;
    }
    const seatsPaid = seatDays > 0 ? seatDays : null;
    const rentPerSeat = seatsPaid !== null && rentDays > 0 ? rentDays / seatsPaid : null;

    // ── Door access ──────────────────────────────────────────────────
    let seatsUsed: number | null = null;
    let doorFlag: DataFlags["door"] = "none";
    if (raw.door) {
      doorFlag = raw.door.mapped ? "mapped" : "unmapped";
      if (raw.door.mapped) {
        const openDays = [...new Set(raw.door.centerActiveDays)].filter((d) => monthStart(d) === month && d <= asOf);
        if (openDays.length > 0) {
          const peopleByDay = new Map<string, Set<string>>();
          for (const e of raw.door.events) {
            if (e.direction !== "IN" || monthStart(e.date) !== month || e.date > asOf) continue;
            const set = peopleByDay.get(e.date) ?? new Set<string>();
            set.add(e.person);
            peopleByDay.set(e.date, set);
          }
          seatsUsed = openDays.reduce((sum, d) => sum + (peopleByDay.get(d)?.size ?? 0), 0) / openDays.length;
        }
      }
    }

    // ── Tickets, bookings, queries ───────────────────────────────────
    const tickets = raw.tickets.filter((t) => monthStart(istDate(t.reported_at)) === month && istDate(t.reported_at) <= asOf);
    const rated = tickets.filter((t) => t.satisfaction_rating !== null);
    const bookings = raw.bookings.filter(
      (b) => monthStart(b.booking_date) === month && b.booking_date <= asOf && !NON_ENGAGEMENT_BOOKING_STATUSES.has(b.status)
    ).length;
    const queries =
      raw.billingQueries === null
        ? null
        : raw.billingQueries.filter((q) => monthStart(istDate(q.created_at)) === month && istDate(q.created_at) <= asOf).length;

    rows.push({
      month,
      revenue_ex_gst: revenue,
      invoiced_count: dueThisMonth.length,
      avg_days_late: measured > 0 ? lateDaysTotal / measured : null,
      measured_count: measured,
      on_time_count: onTime,
      overdue_amount: overdueAmount,
      max_days_overdue: maxDaysOverdue,
      reminders,
      concessions_counted: concessions,
      seats_paid: seatsPaid,
      seats_used_avg: seatsUsed,
      rent_per_seat: rentPerSeat,
      tickets_linked: tickets.length,
      tickets_sla_breached: tickets.filter((t) => t.sla_breached === true).length,
      tickets_reopened: tickets.filter((t) => (t.reopen_count ?? 0) > 0).length,
      satisfaction_avg: rated.length > 0 ? rated.reduce((sum, t) => sum + (t.satisfaction_rating as number), 0) / rated.length : null,
      satisfaction_count: rated.length,
      bookings,
      billing_queries: queries,
      tickets_unlinked: raw.ticketsUnlinkedByMonth?.[month] ?? 0,
      data_flags: {
        invoices_without_due_date: withoutDueDate,
        door: doorFlag,
        billing_queries_available: raw.billingQueries !== null,
        partial_month: mEnd > asOf,
      },
    });
  }
  return rows;
}

/** The date to score a month as of: its last day, or `today` if the month is not over yet. Used to step a backfill. */
export function asOfForMonth(month: string, today: string): string {
  const end = monthEnd(month);
  return end <= today ? end : today;
}

/** The as-of dates a backfill steps through: each month end from `from`'s month, ending at `to`. */
export function monthEndsBetween(from: string, to: string): string[] {
  return monthRange(from, to).map((month) => asOfForMonth(month, to));
}
