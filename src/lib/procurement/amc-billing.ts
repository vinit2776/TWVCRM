import { BILLING_CYCLE_MONTHS, type ServicePoBillingCycle } from "@/lib/constants";

/**
 * Cycle maths shared by the AMC material request form, the service PO form and
 * the AMC register, so all three agree on what a contract is worth.
 *
 * The invariant everything else depends on: a contract's total commitment is
 * always `unit cost per cycle x cycle count`. Yearly contracts are simply the
 * one-cycle case, which is why pre-existing AMCs need no migration.
 */

/**
 * Recover the billing frequency from a request's synthesized AMC line item.
 *
 * The line item already carries the whole picture — unit is the cycle, quantity
 * the cycle count, estimated_price the per-cycle cost — so no separate column is
 * needed on purchase_requests to remember how a contract is paid.
 */
export function cycleFromUnit(unit: string | null | undefined): ServicePoBillingCycle {
  switch (unit) {
    case "month": return "monthly";
    case "quarter": return "quarterly";
    default: return "yearly";
  }
}

/** Per-cycle noun used in labels and totals — "₹5,000/month". */
export const CYCLE_UNIT_LABEL: Record<ServicePoBillingCycle, string> = {
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

/** Cost-field label; a yearly AMC reads as one contract value, not a rate. */
export const CYCLE_COST_LABEL: Record<ServicePoBillingCycle, string> = {
  monthly: "Cost per Month",
  quarterly: "Cost per Quarter",
  yearly: "Annual Contract Value",
};

/**
 * Number of billing cycles spanned by an AMC period.
 *
 * Contract periods are quoted inclusively — Apr 1 to Mar 31 is a full 12 months —
 * so the end date is advanced by one day and the span measured as a half-open
 * interval. That also absorbs the two ways vendors write an anniversary
 * (Mar 30 → Mar 29 and Mar 30 → Mar 30 are both 12 months).
 *
 * Dates are parsed component-wise rather than via `new Date(string)`, whose
 * UTC-midnight parsing shifts the day backwards in any timezone behind UTC.
 *
 * Returns null when either date is missing or the range is inverted, letting
 * callers fall back to a manually entered count.
 */
function parseDateParts(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  return { y: Number(y), m: Number(m), d: Number(d) };
}

export function cyclesBetween(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  cycle: ServicePoBillingCycle
): number | null {
  if (!startDate || !endDate) return null;
  const start = parseDateParts(startDate);
  const end = parseDateParts(endDate);
  if (!start || !end) return null;

  // Half-open: the day after the inclusive end date.
  const exclusive = new Date(Date.UTC(end.y, end.m - 1, end.d + 1));
  const startUtc = new Date(Date.UTC(start.y, start.m - 1, start.d));
  if (exclusive <= startUtc) return null;

  let months =
    (exclusive.getUTCFullYear() - start.y) * 12 +
    (exclusive.getUTCMonth() + 1 - start.m);
  // A partial final month does not complete another whole month.
  if (exclusive.getUTCDate() < start.d) months -= 1;

  const perCycle = BILLING_CYCLE_MONTHS[cycle] ?? 12;
  return Math.max(1, Math.round(months / perCycle));
}

/** Full contract commitment. Guards against NaN reaching a currency field. */
export function contractTotal(unitCostPerCycle: number, cycleCount: number): number {
  if (!Number.isFinite(unitCostPerCycle) || !Number.isFinite(cycleCount)) return 0;
  return Math.max(0, unitCostPerCycle) * Math.max(0, cycleCount);
}

/**
 * How much of a contract has been invoiced, for the progress readout.
 * Counts bills rather than summing amounts: a cycle is billed once the vendor
 * has raised an invoice for it, whatever it was ultimately approved at.
 */
export function billingProgress(
  billCount: number,
  cycleCount: number | null | undefined,
  unitCostPerCycle: number | null | undefined
): { billed: number; total: number; remainingAmount: number; isComplete: boolean } | null {
  if (!cycleCount || cycleCount <= 1) return null;
  const billed = Math.max(0, billCount);
  const remainingCycles = Math.max(0, cycleCount - billed);
  return {
    billed,
    total: cycleCount,
    remainingAmount: remainingCycles * Number(unitCostPerCycle ?? 0),
    isComplete: billed >= cycleCount,
  };
}
