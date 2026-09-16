/**
 * Which Generate & Send run a pending usage charge will actually land in —
 * the "Bills in" line under Logged on the Unbilled list.
 *
 * Mirrors generateUsageStatements' own selection rules in billing.ts so the
 * label can't promise something the run won't do:
 *   - a run targets one month and sweeps every pending charge dated on or
 *     before it (never after), skipping held and stale-unreviewed charges;
 *   - it only covers contracts with status active / renewal_in_progress /
 *     renewed, start_date <= end of that month, and (renewal_in_progress or
 *     end_date >= start of that month);
 *   - a contract whose statement for that month was already sent/paid gets
 *     one automatic supplement, and after that nothing more for the month.
 *
 * Pure — the API route fetches the contract/statement facts and passes them in.
 */

export type NextRunKind = "ready" | "supplement" | "later" | "review" | "held" | "none";

export interface NextRun {
  kind: NextRunKind;
  /** "Aug 2026 run", "Aug 2026 supplement", "On hold", "Not until reviewed" … */
  label: string;
  /** Short reason, e.g. "Opens after 30 Sep", "Aug already billed + supplemented". */
  note: string;
}

export interface YearMonth { year: number; month: number }

export interface NextRunContract {
  status: string;
  start_date: string;
  end_date: string | null;
}

/** Usage/combined statement facts for one contract+month (period_start = 1st). */
export interface MonthCoverage {
  /** An original (non-supplement) statement for the month was sent, GST-issued, or paid. */
  sent: boolean;
  /** A live (non-voided, non-discarded) supplement already exists for that original. */
  supplemented: boolean;
}

export interface NextRunInput {
  /** YYYY-MM-DD — print/facility rows use their period's last day, as the list already does. */
  chargeDate: string;
  held: boolean;
  reviewed: boolean;
  contract: NextRunContract | null;
  /** Today in IST, YYYY-MM-DD. */
  today: string;
  reviewAfterDays: number;
  /** Coverage for a contract+month; return null when nothing covers it. */
  coverageFor: (ym: YearMonth) => MonthCoverage | null;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ymOf(ymd: string): YearMonth {
  return { year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)) };
}
function cmp(a: YearMonth, b: YearMonth): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}
function next(ym: YearMonth): YearMonth {
  return ym.month === 12 ? { year: ym.year + 1, month: 1 } : { year: ym.year, month: ym.month + 1 };
}
function prev(ym: YearMonth): YearMonth {
  return ym.month === 1 ? { year: ym.year - 1, month: 12 } : { year: ym.year, month: ym.month - 1 };
}
function firstDay(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}-01`;
}
function lastDay(ym: YearMonth): string {
  const d = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
  return `${ym.year}-${String(ym.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function monthShort(ym: YearMonth): string {
  return `${MONTHS_SHORT[ym.month - 1]} ${ym.year}`;
}
function dayMonth(ymd: string): string {
  return `${Number(ymd.slice(8, 10))} ${MONTHS_SHORT[Number(ymd.slice(5, 7)) - 1]}`;
}

function contractCovers(c: NextRunContract, ym: YearMonth): boolean {
  if (!["active", "renewal_in_progress", "renewed"].includes(c.status)) return false;
  if (c.start_date > lastDay(ym)) return false;
  if (c.status === "renewal_in_progress") return true;
  return !!c.end_date && c.end_date >= firstDay(ym);
}

/** Up to this many months ahead is enough for any real contract gap. */
const MAX_LOOKAHEAD = 24;

export function nextUsageRun(input: NextRunInput): NextRun {
  const { chargeDate, held, reviewed, contract, today, reviewAfterDays, coverageFor } = input;

  if (held) return { kind: "held", label: "On hold", note: "Skipped by every run" };

  const current = ymOf(today);
  const closed = prev(current);
  const chargeYm = ymOf(chargeDate);

  // Stale check uses the same day-count cutoff as the generator.
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - reviewAfterDays);
  const stale = !reviewed && chargeDate < cutoff.toISOString().slice(0, 10);

  if (!contract) return { kind: "none", label: "Won't auto-bill", note: "Not linked to a contract" };

  // Earliest run that can see this charge: its own month, but never before
  // the last closed month (older charges are swept by that run).
  let target = cmp(chargeYm, closed) > 0 ? chargeYm : closed;
  const reasons: string[] = [];

  for (let i = 0; i < MAX_LOOKAHEAD; i++) {
    if (!contractCovers(contract, target)) {
      if (contract.start_date > lastDay(target)) {
        if (i === 0 && cmp(target, closed) === 0) reasons.push(`${MONTHS_SHORT[target.month - 1]} skipped — contract starts ${dayMonth(contract.start_date)}`);
        target = ymOf(contract.start_date);
        continue;
      }
      return { kind: "none", label: "Won't auto-bill", note: "Contract isn't active for billing" };
    }

    const cov = coverageFor(target);
    if (cov?.sent && cov.supplemented) {
      reasons.push(`${MONTHS_SHORT[target.month - 1]} already billed + supplemented`);
      target = next(target);
      continue;
    }

    const isSupplement = !!cov?.sent;
    const runLabel = `${monthShort(target)} ${isSupplement ? "supplement" : "run"}`;
    const openNow = cmp(target, current) < 0;

    if (stale) {
      return { kind: "review", label: "Not until reviewed", note: `Over ${reviewAfterDays} days — then ${runLabel}` };
    }
    if (!openNow) {
      const why = reasons.length ? reasons.join("; ") : `Opens after ${dayMonth(lastDay(target))}`;
      return { kind: "later", label: runLabel, note: why };
    }
    if (isSupplement) {
      return { kind: "supplement", label: runLabel, note: `${MONTHS_SHORT[target.month - 1]} already sent — top-up bill` };
    }
    return { kind: "ready", label: runLabel, note: "Ready — Generate & Send now" };
  }
  return { kind: "none", label: "Won't auto-bill", note: "No billable month found" };
}
