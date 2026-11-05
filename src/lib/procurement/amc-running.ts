import { BILLING_CYCLE_MONTHS, type ServicePoBillingCycle } from "@/lib/constants";
import { cyclesBetween } from "@/lib/procurement/amc-billing";

/**
 * Setting up an AMC that began before it was entered here.
 *
 * Cycles already billed and paid elsewhere are recorded as an opening position, never
 * as invoices. `opening_cycles` on the request is how many of the contract's cycles are
 * done; the request's line quantity is only the cycles still to bill here.
 */

export interface CyclePeriod {
  /** 1-based, across the whole contract. */
  n: number;
  from: string;
  to: string;
}

function parse(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The date `months` after `start`, clamped to the month's last day (31 Jan + 1 month = 28 Feb). */
function addMonths(start: { y: number; m: number; d: number }, months: number) {
  const total = start.y * 12 + (start.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(start.d, daysIn(y, m)) };
}

function dayBefore(p: { y: number; m: number; d: number }): string {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Each billing cycle of a contract with its dates, in order. The last one ends on the contract end date. */
export function cycleSchedule(
  startDate: string,
  endDate: string,
  cycle: ServicePoBillingCycle,
  countOverride?: number | null
): CyclePeriod[] {
  const start = parse(startDate);
  const count = countOverride && countOverride > 0 ? countOverride : cyclesBetween(startDate, endDate, cycle);
  if (!start || !count) return [];
  const months = BILLING_CYCLE_MONTHS[cycle] ?? 12;
  const out: CyclePeriod[] = [];
  for (let k = 0; k < count; k++) {
    const from = addMonths(start, k * months);
    const next = addMonths(start, (k + 1) * months);
    out.push({ n: k + 1, from: iso(from.y, from.m, from.d), to: dayBefore(next) });
  }
  // The contract's own end date wins over month arithmetic (a 31st start clamps early).
  if (out.length && parse(endDate) && !countOverride) out[out.length - 1].to = endDate;
  return out;
}

/** True when the contract began before `today` (both YYYY-MM-DD). */
export function startedBefore(startDate: string, today: string): boolean {
  return !!startDate && !!today && startDate < today;
}

/**
 * How many leading cycles can be marked as already paid: those that have ended, but
 * never the last cycle, so something is always left to bill here.
 */
export function maxSettledCycles(schedule: CyclePeriod[], today: string): number {
  const ended = schedule.filter((p) => p.to < today).length;
  return Math.max(0, Math.min(ended, schedule.length - 1));
}

export interface RunningFigures {
  /** Whole contract before GST. */
  full: number;
  /** Cycles settled before this system. */
  paid: number;
  /** What is left to approve and bill here. */
  remaining: number;
}

/** Per-line figures: `count` is the whole contract's cycle count for that line. */
export function runningFigures(perCycleCost: number, count: number, opening: number): RunningFigures {
  const cost = Number.isFinite(perCycleCost) ? Math.max(0, perCycleCost) : 0;
  const open = Math.min(Math.max(0, opening), Math.max(0, count - 1));
  return { full: cost * count, paid: cost * open, remaining: cost * (count - open) };
}

/**
 * Opening position only works when every asset shares one schedule, because the
 * request records a single count of settled cycles. Returns the reason it can't, or null.
 */
export function runningScheduleProblem(
  lines: Array<{ billingCycle: ServicePoBillingCycle; count: number }>
): string | null {
  if (lines.length < 2) return null;
  const first = lines[0];
  const same = lines.every((l) => l.billingCycle === first.billingCycle && l.count === first.count);
  return same
    ? null
    : "A contract that is already running needs every asset on the same billing frequency and number of bills. Make them match, or raise separate requests.";
}
