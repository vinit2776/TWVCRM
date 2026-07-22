/**
 * Pure date math for tiered rate-phase boundaries — zero dependencies, safe
 * to import from both server code (billing.ts) and client code (the phase
 * editor UI, jsPDF-based PDF generators). This is the single source of truth
 * for "what date range does phase N actually cover" — every consumer must
 * import from here rather than reimplementing the math, so the editor
 * preview, the generated PDFs, and the billing engine can never disagree.
 */

export interface RatePhaseInput {
  phase_order: number;
  duration_months: number;
  monthly_rate: number;
  /** Explicit day-precise end date, overriding the default calendar-month boundary. */
  end_date?: string | null;
}

export interface PhaseBoundary {
  order: number;
  start: string;
  end: string;
  rate: number;
}

/** Add `days` calendar days to a YYYY-MM-DD string. */
export function addDaysToYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD strings (end >= start). */
export function daysBetweenInclusiveYmd(startYmd: string, endYmd: string): number {
  const start = new Date(startYmd + "T00:00:00Z").getTime();
  const end = new Date(endYmd + "T00:00:00Z").getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

/** Last day of the month that is `durationMonths - 1` months after `startYmd`'s month. */
export function endOfMonthNMonthsFrom(startYmd: string, durationMonths: number): string {
  const [y, m] = startYmd.split("-").map(Number);
  const zeroIndexed = (m - 1) + (durationMonths - 1);
  const targetYear = y + Math.floor(zeroIndexed / 12);
  const targetMonth = (zeroIndexed % 12) + 1; // 1-indexed
  const daysInTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(daysInTargetMonth).padStart(2, "0")}`;
}

/**
 * Day-precise [start, end] date range per phase, anchored at phaseAnchorDate.
 * A phase's end is its own `end_date` when customised, otherwise derived from
 * cumulative duration_months (the calendar-month-bucket default). Each phase
 * starts the day after the previous phase ends — so once an earlier phase's
 * boundary is customised off the month grid, later un-customised phases
 * naturally measure "N months from their own actual start" rather than from
 * the original anchor. This is a no-op (identical to pure calendar-month
 * bucketing) whenever no phase has a custom end_date.
 */
export function computePhaseBoundaries(phaseAnchorDate: string, phases: RatePhaseInput[]): PhaseBoundary[] {
  const sorted = [...phases].sort((a, b) => a.phase_order - b.phase_order);
  const boundaries: PhaseBoundary[] = [];
  let cursorStart = phaseAnchorDate;
  for (const phase of sorted) {
    const end = phase.end_date || endOfMonthNMonthsFrom(cursorStart, phase.duration_months);
    boundaries.push({ order: phase.phase_order, start: cursorStart, end, rate: Number(phase.monthly_rate) });
    cursorStart = addDaysToYmd(end, 1);
  }
  return boundaries;
}

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 1–23, 2026" (or "Aug 28 – Sep 3, 2026" if the range spans a month boundary). */
export function formatDateRange(startYmd: string, endYmd: string): string {
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ey, em, ed] = endYmd.split("-").map(Number);
  const sLabel = `${MONTH_ABBREVIATIONS[sm - 1]} ${sd}`;
  if (sy === ey && sm === em) return `${sLabel}–${ed}, ${ey}`;
  const eLabel = `${MONTH_ABBREVIATIONS[em - 1]} ${ed}`;
  return `${sLabel}${sy !== ey ? `, ${sy}` : ""} – ${eLabel}, ${ey}`;
}

/** "Aug 1, 2026" */
export function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTH_ABBREVIATIONS[m - 1]} ${d}, ${y}`;
}
