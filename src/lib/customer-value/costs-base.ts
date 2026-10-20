/**
 * Customer Value — turning stored figures into the simulator's base
 * (docs/plans/customer-value-phase5-cost-simulator.md, PR C).
 *
 * Pure. The simulator works on monthly averages over the last few COMPLETED
 * months (the running month is partial). A figure that cannot be measured stays
 * null and is never turned into zero: the simulator then says "needs input".
 */

import type { SimBase } from "@/lib/customer-value/cost-simulator";
import type { ElectricityMonth } from "@/lib/customer-value/electricity-share";

export const BASE_WINDOW_MONTHS = 6;
/**
 * Door access gives average people present per open day; turning that into
 * person-days needs a number of open days. 26 is an approximation (six days a
 * week), used only when door data exists. It is never used today: door data is
 * not loaded into the monthly figures yet.
 */
export const OPEN_DAYS_PER_MONTH = 26;

export interface CostsMonthRow {
  /** First day of the month, YYYY-MM-DD */
  month: string;
  revenue_ex_gst: number;
  avg_days_late: number | null;
  measured_count: number;
  concessions_counted: number;
  seats_paid: number | null;
  seats_used_avg: number | null;
  rent_per_seat: number | null;
}

export interface CostsBaseInput {
  rows: CostsMonthRow[];
  /** YYYY-MM-DD */
  today: string;
  /** This customer's electricity months (phase 4); null when the center cannot be measured. */
  electricityMonths: ElectricityMonth[] | null;
  /** Tickets explicitly tied to this customer, ever. Zero means staff time cannot be attributed yet. */
  ticketsLinked: number;
  /** Minutes logged on those tickets inside the window. */
  staffMinutes: number;
  /** Earliest contract start, YYYY-MM-DD. */
  firstContractStart: string | null;
  centerLease: number | null;
  centerSeats: number | null;
}

export interface CostsBase {
  base: SimBase;
  /** The completed months the averages cover, oldest first. */
  months: string[];
}

const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const monthIndex = (ymd: string) => Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7)) - 1;

/** The last `BASE_WINDOW_MONTHS` completed months that have a stored row, or null when there is nothing to average. */
export function buildCostsBase(input: CostsBaseInput): CostsBase | null {
  const thisMonth = monthIndex(input.today);
  const win = input.rows
    .filter((r) => monthIndex(r.month) < thisMonth && monthIndex(r.month) >= thisMonth - BASE_WINDOW_MONTHS)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  if (win.length === 0) return null;

  const seats = mean(win.flatMap((r) => (r.seats_paid === null ? [] : [r.seats_paid]))) ?? 0;
  if (!(seats > 0)) return null;

  const winMonths = new Set(win.map((r) => r.month.slice(0, 7)));
  const electricity = (input.electricityMonths ?? []).filter((m) => !m.partial && winMonths.has(m.month) && m.cost !== null);

  const timed = win.filter((r) => r.measured_count > 0 && r.avg_days_late !== null);
  const timedCount = timed.reduce((n, r) => n + r.measured_count, 0);
  // Early payment is no cost, so each month's average is floored at zero before weighting.
  const avgDaysLate = timedCount > 0 ? timed.reduce((n, r) => n + Math.max(0, r.avg_days_late as number) * r.measured_count, 0) / timedCount : null;

  const present = mean(win.flatMap((r) => (r.seats_used_avg === null ? [] : [r.seats_used_avg])));
  const tenureMonths = input.firstContractStart
    ? Math.max(1, monthIndex(input.today) - monthIndex(input.firstContractStart) + (Number(input.today.slice(8, 10)) >= Number(input.firstContractStart.slice(8, 10)) ? 0 : -1))
    : null;

  return {
    months: win.map((r) => r.month.slice(0, 7)),
    base: {
      months: win.length,
      seats,
      revenue: mean(win.map((r) => r.revenue_ex_gst)) ?? 0,
      rentPerSeat: mean(win.flatMap((r) => (r.rent_per_seat === null ? [] : [r.rent_per_seat]))),
      electricityCost: electricity.length > 0 ? (mean(electricity.map((m) => m.cost as number)) as number) : null,
      concessions: mean(win.map((r) => r.concessions_counted)) ?? 0,
      staffMinutes: input.ticketsLinked > 0 ? input.staffMinutes / win.length : null,
      avgDaysLate,
      personDays: present === null ? null : present * OPEN_DAYS_PER_MONTH,
      tenureMonths,
      centerLease: input.centerLease,
      centerSeats: input.centerSeats,
    },
  };
}
