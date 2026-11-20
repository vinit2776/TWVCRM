/**
 * Escalation cycle: the monthly fee steps up every N months inside the term
 * (11 by default, 12 on request), compounding on the previous rounded fee.
 *
 * Pure, dependency-free date and money maths. The stepped fees are stored as
 * contract_rate_phases rows (billing already prices those, day by day), and the
 * proposal, agreement, addendum and contract page all print this one schedule,
 * so documents and invoices cannot disagree.
 */
import { addDaysToYmd, type RatePhaseInput } from "@/lib/rate-phase-dates";

export const ESCALATION_CYCLE_OPTIONS = [11, 12] as const;
export type EscalationCycleMonths = (typeof ESCALATION_CYCLE_OPTIONS)[number];
export const DEFAULT_ESCALATION_CYCLE_MONTHS: EscalationCycleMonths = 11;

export function isEscalationCycle(v: unknown): v is EscalationCycleMonths {
  return v === 11 || v === 12;
}

export interface CycleStep {
  order: number;
  /** First day at this fee. */
  start: string;
  /** Last day at this fee (the contract's last day for the final step). */
  end: string;
  /** Monthly fee, excluding GST. */
  rate: number;
}

/** `ymd` plus whole months, keeping the day (clamped to the month's last day). */
export function addMonthsClampedYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const zero = (m - 1) + months;
  const year = y + Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * The stepped fee schedule for a term, or [] when the term is no longer than one
 * cycle (nothing steps, so the contract keeps today's wording and billing).
 * Steps fall on the anniversary of `anchorYmd` after every `cycleMonths`; the
 * last step runs to `endYmd`.
 */
export function buildCycleSchedule(input: {
  anchorYmd: string;
  endYmd: string;
  baseRate: number;
  percent: number;
  cycleMonths: number;
}): CycleStep[] {
  const { anchorYmd, endYmd, baseRate, percent, cycleMonths } = input;
  if (!(baseRate > 0) || !(cycleMonths > 0) || !(anchorYmd <= endYmd)) return [];
  const starts: string[] = [anchorYmd];
  for (let i = 1; ; i++) {
    const next = addMonthsClampedYmd(anchorYmd, cycleMonths * i);
    if (next > endYmd) break;
    starts.push(next);
  }
  if (starts.length < 2) return [];
  const multiplier = 1 + (Number.isFinite(percent) ? percent : 0) / 100;
  let rate = Math.round(baseRate);
  return starts.map((start, i) => {
    if (i > 0) rate = Math.round(rate * multiplier);
    const end = i === starts.length - 1 ? endYmd : addDaysToYmd(starts[i + 1], -1);
    return { order: i + 1, start, end, rate };
  });
}

/** The schedule as contract_rate_phases input (each phase carries its own end date). */
export function cycleToPhases(steps: CycleStep[], cycleMonths: number): RatePhaseInput[] {
  return steps.map((s) => ({
    phase_order: s.order,
    duration_months: cycleMonths,
    monthly_rate: s.rate,
    end_date: s.end,
  }));
}

/** The fee a renewal starts from: the last stepped fee, or the base fee with no steps. */
export function finalCycleRate(steps: CycleStep[], fallbackRate: number): number {
  return steps.length > 0 ? steps[steps.length - 1].rate : fallbackRate;
}

/** The step in force on `todayYmd` and the next one, for the contract page. */
export function currentAndNextStep(steps: CycleStep[], todayYmd: string): { current: CycleStep | null; next: CycleStep | null } {
  const current = steps.find((s) => s.start <= todayYmd && todayYmd <= s.end) ?? null;
  const next = steps.find((s) => s.start > todayYmd) ?? null;
  return { current, next };
}

export interface FeeLine {
  quantity: number;
  unit_price: number;
  total: number;
  [key: string]: unknown;
}

/**
 * Scales every line by target/current so the lines add up to `targetTotal`
 * to within a paisa (a renewal starting at the last stepped fee must read as that fee, not
 * a rupee or two off from per-line rounding). The rounding remainder goes onto
 * the largest line's unit price, to the paisa.
 */
export function fitLinesToTotal<T extends FeeLine>(lines: T[], targetTotal: number): T[] {
  const current = lines.reduce((sum, l) => sum + l.total, 0);
  if (!(current > 0) || !(targetTotal > 0)) return lines;
  const ratio = targetTotal / current;
  const scaled = lines.map((l) => {
    const unit = Math.round(l.unit_price * ratio);
    return { ...l, unit_price: unit, total: unit * l.quantity };
  });
  const residual = Math.round((targetTotal - scaled.reduce((sum, l) => sum + l.total, 0)) * 100) / 100;
  if (residual === 0) return scaled;
  let big = 0;
  scaled.forEach((l, i) => { if (l.total > scaled[big].total) big = i; });
  const q = Math.max(1, scaled[big].quantity);
  const unit = Math.round((scaled[big].unit_price + residual / q) * 100) / 100;
  scaled[big] = { ...scaled[big], unit_price: unit, total: Math.round(unit * q * 100) / 100 };
  return scaled;
}

/**
 * A renewal's lines at the fee carried from the last cycle step. With the same
 * seat count they add up to that fee exactly; with a different one the stepped
 * per-seat rate is kept and the quantity follows the new seats.
 */
export function carryItemsAtFee<T extends FeeLine>(items: T[], oldSeats: number, newSeats: number, fee: number): T[] {
  const fitted = fitLinesToTotal(items, fee);
  if (newSeats === oldSeats) return fitted;
  return fitted.map((l) => {
    const quantity = l.quantity === oldSeats ? newSeats : l.quantity;
    return { ...l, quantity, total: Math.round(l.unit_price * quantity * 100) / 100 };
  });
}

export interface TermStepRow {
  /** "Months 1 to 11" (plain ASCII: the PDF's built-in font drops an en dash). */
  label: string;
  rate: number;
}

/**
 * The same schedule counted in months from the start, for a proposal that has no
 * dates yet. Empty when the term is not longer than one cycle. The rates come from
 * buildCycleSchedule, so a proposal and the contract made from it print the same fees.
 */
export function termStepRows(input: { baseRate: number; percent: number; cycleMonths: number; tenureMonths: number }): TermStepRow[] {
  const { baseRate, percent, cycleMonths, tenureMonths } = input;
  if (!(tenureMonths > cycleMonths)) return [];
  const anchor = "2000-01-01";
  const end = addDaysToYmd(addMonthsClampedYmd(anchor, tenureMonths), -1);
  const steps = buildCycleSchedule({ anchorYmd: anchor, endYmd: end, baseRate, percent, cycleMonths });
  return steps.map((s, i) => {
    const from = cycleMonths * i + 1;
    const to = i === steps.length - 1 ? tenureMonths : cycleMonths * (i + 1);
    return { label: from === to ? `Month ${from}` : `Months ${from} to ${to}`, rate: s.rate };
  });
}
