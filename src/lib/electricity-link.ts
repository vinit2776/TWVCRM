// Pure rules for linking an uploaded electricity vendor bill to its details: charge lines,
// which month the bill counts as, and the objective checks against OneGrid. No I/O — the API
// loads the facts, so the dialog and the server apply the same rules and each is unit-testable.
//
// The checks against OneGrid only ever warn or suggest. They use data we already hold (the
// meter's own running total, and the previous bill's closing reading) and never depend on how
// the bill words the site.

import { addDays } from "@/lib/energy-baseline";
import type { MidnightReadings } from "@/lib/energy-monthly";

export const CHARGE_CATEGORIES = ["energy", "generator", "fixed_demand", "pf_adjustment", "taxes", "arrears", "other"] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const CHARGE_LABELS: Record<ChargeCategory, string> = {
  energy: "Energy (grid units)",
  generator: "Generator (DG) units",
  fixed_demand: "Fixed / demand charge",
  pf_adjustment: "Power factor adjustment",
  taxes: "Taxes & duty",
  arrears: "Arrears / adjustments",
  other: "Other",
};

/** Categories billed as units × rate; all others carry a plain amount (which may be negative, e.g. a PF rebate). */
export const UNIT_CATEGORIES: readonly ChargeCategory[] = ["energy", "generator"];
export const isUnitCategory = (c: ChargeCategory) => UNIT_CATEGORIES.includes(c);

export interface LinkLine {
  charge_category: ChargeCategory;
  meter_label?: string | null;
  label?: string | null;
  units?: number | null;
  rate?: number | null;
  amount?: number | null;
}

/** Tolerance when comparing the lines with the vendor bill total (rounding on paper bills). */
export const TOTAL_TOLERANCE = 1;
/** A billing period longer than this looks like a typo (utilities bill monthly or two-monthly). */
export const MAX_PERIOD_DAYS = 93;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A line's amount: units × rate for unit lines, the entered amount otherwise. Null when it can't be worked out. */
export function lineAmount(l: LinkLine): number | null {
  if (isUnitCategory(l.charge_category)) {
    const u = Number(l.units);
    const r = Number(l.rate);
    return Number.isFinite(u) && Number.isFinite(r) && u > 0 && r > 0 ? round2(u * r) : null;
  }
  const a = Number(l.amount);
  return l.amount != null && Number.isFinite(a) && a !== 0 ? round2(a) : null;
}

export function sumLines(lines: readonly LinkLine[]): number {
  return round2(lines.reduce((a, l) => a + (lineAmount(l) ?? 0), 0));
}

/** Grid (utility) kWh billed: the energy lines only — generator units are not on the main meter. */
export function gridUnits(lines: readonly LinkLine[]): number {
  return round2(lines.filter((l) => l.charge_category === "energy").reduce((a, l) => a + (Number(l.units) || 0), 0));
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monthKeyOf = (date: string) => date.slice(0, 7);

/**
 * The month a bill counts as: the calendar month holding most of the period's days, so a
 * 5 Sep–4 Oct bill is September. Equal halves go to the month the period ends in.
 */
export function billMonthOf(periodStart: string, periodEnd: string): { month: number; year: number } {
  const days = new Map<string, number>();
  for (let d = periodStart; d <= periodEnd; d = addDays(d, 1)) {
    const k = monthKeyOf(d);
    days.set(k, (days.get(k) ?? 0) + 1);
  }
  const endKey = monthKeyOf(periodEnd);
  let best = endKey;
  let bestDays = days.get(endKey) ?? 0;
  for (const [k, n] of days) if (n > bestDays) { best = k; bestDays = n; }
  const [y, m] = best.split("-").map(Number);
  return { month: m, year: y };
}

export interface LinkInput {
  period_start: string;
  period_end: string;
  opening_reading: number | null;
  closing_reading: number | null;
  max_demand_kva: number | null;
  billed_pf: number | null;
  lines: readonly LinkLine[];
}

export interface LinkCheck { errors: string[]; warnings: string[] }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything that can be checked without the database. The database function re-checks the invariants under a lock. */
export function checkLinkInput(input: LinkInput, vendorTotal: number): LinkCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!DATE_RE.test(input.period_start) || !DATE_RE.test(input.period_end)) {
    errors.push("Enter the billing period (from and to dates).");
  } else if (input.period_end < input.period_start) {
    errors.push("The billing period ends before it starts.");
  } else if (daysBetween(input.period_start, input.period_end) > MAX_PERIOD_DAYS) {
    errors.push(`A billing period longer than ${MAX_PERIOD_DAYS} days looks wrong — check the dates.`);
  }

  if (input.lines.length === 0) errors.push("Add at least one charge line.");
  input.lines.forEach((l, i) => {
    if (lineAmount(l) == null) {
      errors.push(isUnitCategory(l.charge_category) ? `Line ${i + 1}: units and a rate above zero are needed.` : `Line ${i + 1}: an amount is needed.`);
    }
  });
  if (input.lines.length > 0 && !input.lines.some((l) => l.charge_category === "energy")) {
    warnings.push("No energy (grid units) line — the units can't be compared with the meter.");
  }

  if (input.lines.length > 0 && input.lines.every((l) => lineAmount(l) != null)) {
    const total = sumLines(input.lines);
    if (Math.abs(total - vendorTotal) > TOTAL_TOLERANCE) {
      const diff = round2(total - vendorTotal);
      errors.push(
        `The lines add up to ₹${total.toLocaleString("en-IN")} but the vendor bill is ₹${vendorTotal.toLocaleString("en-IN")} ` +
          `(${diff > 0 ? "₹" + diff.toLocaleString("en-IN") + " over" : "₹" + Math.abs(diff).toLocaleString("en-IN") + " short"}). The bill is what gets paid, so the details must agree with it.`
      );
    }
  }

  const { opening_reading: open, closing_reading: close } = input;
  if ((open == null) !== (close == null)) {
    errors.push("Enter both the opening and the closing meter reading, or neither.");
  } else if (open != null && close != null) {
    if (close < open) errors.push("The closing reading is lower than the opening reading.");
    else {
      const used = close - open;
      const grid = gridUnits(input.lines);
      // A meter multiplying factor is common on HT connections, so a difference is a prompt, not a mistake.
      if (grid > 0 && used > 0 && Math.abs(used - grid) / grid > 0.02) {
        warnings.push(`The readings differ by ${used.toLocaleString("en-IN")} but the energy line says ${grid.toLocaleString("en-IN")} units. That is normal if the meter has a multiplying factor; otherwise check one of them.`);
      }
    }
  }

  if (input.max_demand_kva != null && !(input.max_demand_kva > 0)) errors.push("Maximum demand must be above zero.");
  if (input.billed_pf != null && !(input.billed_pf > 0 && input.billed_pf <= 1)) errors.push("Power factor must be between 0 and 1.");

  return { errors, warnings };
}

// ── Checks against OneGrid ────────────────────────────────────────────────────

/** Billed within this of what the meter recorded counts as agreeing. */
export const FIT_TOLERANCE_PCT = 2;
/** Beyond this it looks like the wrong location (or a very different meter). */
export const FIT_WARN_PCT = 10;

export type FitStatus = "fits" | "close" | "off" | "unknown";

/** How billed units compare with what OneGrid recorded over the same dates at one location. */
export function fitVerdict(billedKwh: number, observedKwh: number | null): { pct: number | null; status: FitStatus } {
  if (observedKwh == null || observedKwh <= 0 || !(billedKwh > 0)) return { pct: null, status: "unknown" };
  const pct = Math.round((billedKwh / observedKwh - 1) * 1000) / 10;
  const abs = Math.abs(pct);
  return { pct, status: abs <= FIT_TOLERANCE_PCT ? "fits" : abs <= FIT_WARN_PCT ? "close" : "off" };
}

/**
 * kWh the meter recorded from the start of `startDate` to the end of `endDate` (IST days), as the
 * difference of two midnight readings. Null when either reading is missing or the register went backwards.
 */
export function kwhBetween(readings: MidnightReadings, startDate: string, endDate: string): number | null {
  const start = readings.get(startDate);
  const end = readings.get(addDays(endDate, 1));
  if (start == null || end == null || end < start) return null;
  return Math.round(((end - start) / 1000) * 10) / 10;
}

export type ContinuityStatus = "continues" | "gap" | "overlap" | "unknown";
/** Meter readings are whole numbers; allow this much for rounding on the printed bill. */
export const CONTINUITY_TOLERANCE = 1;

/**
 * This bill's opening reading should equal the previous bill's closing reading on the same
 * connection. A higher opening means readings were missed (a bill in between, or the wrong
 * connection); a lower one means the periods overlap or this is not the next bill.
 */
export function continuityVerdict(opening: number | null, previousClosing: number | null): { diff: number | null; status: ContinuityStatus } {
  if (opening == null || previousClosing == null) return { diff: null, status: "unknown" };
  const diff = Math.round((opening - previousClosing) * 100) / 100;
  if (Math.abs(diff) <= CONTINUITY_TOLERANCE) return { diff, status: "continues" };
  return { diff, status: diff > 0 ? "gap" : "overlap" };
}
