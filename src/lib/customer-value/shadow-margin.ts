/**
 * Customer Value — one customer-month's shadow margin
 * (docs/plans/customer-value-phase5-cost-simulator.md, section 5).
 *
 * Pure. Margin AFTER VARIABLE costs only: it is the stable one, and the fully
 * loaded margin depends on allocation rules so it never feeds anything stored.
 * It reuses the simulator's maths with one month's measured figures and the
 * rates in force that month, so what is stored is what the Costs tab would have
 * shown for that month.
 */

import { simulate, type CostKey, type CostParams, type CostStatus } from "@/lib/customer-value/cost-simulator";
import { OPEN_DAYS_PER_MONTH } from "@/lib/customer-value/costs-base";

export const VARIABLE_KEYS: CostKey[] = ["electricity", "concessions", "staff_time", "late_payment", "pantry", "acquisition"];

export interface ShadowMonthInput {
  /** First day of the month, YYYY-MM-DD */
  month: string;
  revenue_ex_gst: number;
  seats_paid: number | null;
  rent_per_seat: number | null;
  concessions_counted: number;
  avg_days_late: number | null;
  measured_count: number;
  seats_used_avg: number | null;
  /** The month's electricity cost attributed to this customer; null when it cannot be measured. */
  electricityCost: number | null;
  /** Minutes logged on tickets tied to this customer that month; null when none is tied to them. */
  staffMinutes: number | null;
  /** Months since the first contract started, as of this month; null when unknown. */
  tenureMonths: number | null;
  /** Rates in force that month. */
  params: CostParams;
}

export interface ShadowMargin {
  month: string;
  revenue: number;
  variable_cost: number;
  margin_after_variable: number;
  margin_pct: number | null;
  /** Share of the variable cost resting on measured data; null when nothing was costed. */
  confidence: number | null;
  lines: Partial<Record<CostKey, { amount: number; status: CostStatus }>>;
}

/** Null when there is nothing to take a margin of: no seats on a contract, or no revenue. */
export function shadowMargin(input: ShadowMonthInput): ShadowMargin | null {
  const seats = input.seats_paid;
  if (seats === null || !(seats > 0) || !(input.revenue_ex_gst > 0)) return null;

  const result = simulate(
    {
      months: 1,
      seats,
      revenue: input.revenue_ex_gst,
      rentPerSeat: input.rent_per_seat,
      electricityCost: input.electricityCost,
      concessions: input.concessions_counted,
      staffMinutes: input.staffMinutes,
      avgDaysLate: input.measured_count > 0 && input.avg_days_late !== null ? Math.max(0, input.avg_days_late) : null,
      personDays: input.seats_used_avg === null ? null : input.seats_used_avg * OPEN_DAYS_PER_MONTH,
      tenureMonths: input.tenureMonths,
      centerLease: null,
      centerSeats: null,
    },
    input.params
  );

  const variable = result.lines.filter((l) => VARIABLE_KEYS.includes(l.key));
  const costed = variable.reduce((n, l) => n + l.amount, 0);
  const measured = variable.filter((l) => l.status === "live").reduce((n, l) => n + l.amount, 0);

  return {
    month: input.month,
    revenue: result.revenue,
    variable_cost: result.variableCost,
    margin_after_variable: result.marginAfterVariable,
    margin_pct: result.marginAfterVariablePct,
    confidence: costed > 0 ? measured / costed : null,
    lines: Object.fromEntries(variable.map((l) => [l.key, { amount: l.amount, status: l.status }])),
  };
}

/** Whole months from the first contract's start to the start of `month`, at least one; null with no start date. */
export function tenureAt(firstContractStart: string | null, month: string): number | null {
  if (!firstContractStart) return null;
  const idx = (ymd: string) => Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(5, 7)) - 1;
  return Math.max(1, idx(month) - idx(firstContractStart) + 1);
}

export interface ShadowRow {
  month: string;
  revenue: number;
  variable_cost: number;
  margin_after_variable: number;
  confidence: number | null;
}

export interface ShadowSummary {
  /** The completed months it covers, oldest first. */
  months: string[];
  /** Average margin a month, rupees. */
  marginPerMonth: number;
  /** Total margin over total revenue, 0 to 1 (negative when costs exceed revenue). */
  marginPct: number | null;
  /** Share of the variable cost resting on measured data, weighted by each month's variable cost; null when nothing was costed. */
  confidence: number | null;
}

/** The shadow margin over a few recent months, or null with none. Revenue-weighted, so a quiet month does not swing it. */
export function summariseShadow(rows: ShadowRow[]): ShadowSummary | null {
  if (rows.length === 0) return null;
  const revenue = rows.reduce((n, r) => n + r.revenue, 0);
  const margin = rows.reduce((n, r) => n + r.margin_after_variable, 0);
  const weights = rows.filter((r) => r.confidence !== null && r.variable_cost > 0);
  const weight = weights.reduce((n, r) => n + r.variable_cost, 0);
  return {
    months: rows.map((r) => r.month.slice(0, 7)).sort(),
    marginPerMonth: Math.round(margin / rows.length),
    marginPct: revenue > 0 ? margin / revenue : null,
    confidence: weight > 0 ? weights.reduce((n, r) => n + (r.confidence as number) * r.variable_cost, 0) / weight : null,
  };
}
