/**
 * How close a Virtual Office case is to running out.
 *
 * One helper for every surface that shows expiry — the Cases list column, the
 * row highlight, and the case page band — so a row cannot be coloured amber
 * while its date reads as comfortable.
 *
 * The subtlety worth knowing: cases.end_date was backfilled (00525) from
 * start_date + tenure_months for *every* case, whether or not its agreement
 * was ever executed. A case still at intake therefore carries a date for a
 * term that never began, and several of those dates are already in the past.
 * Reporting one as "expired" would send someone chasing a renewal that was
 * never live, so anything outside EXPIRY_RELEVANT_STATUSES is reported as a
 * projection instead.
 */
import { EXPIRY_RELEVANT_STATUSES } from "@/lib/constants";

export type ExpiryTone =
  /** No executed agreement — the date is what the term *would* end, muted. */
  | "projected"
  /** Live and comfortably ahead. */
  | "ok"
  /** Inside 30 days. */
  | "soon"
  /** Inside 7 days — the last week before the address stops being valid. */
  | "urgent"
  /** Term end has passed. */
  | "past";

export interface CaseExpiry {
  tone: ExpiryTone;
  /** Days until end_date; negative once past. Null when there is no date. */
  daysRemaining: number | null;
  /** Short relative phrase: "in 12 days", "expired 8 days ago", "not started". */
  relative: string;
  /** True only for tones that should tint a table row. */
  highlight: boolean;
}

const SOON_DAYS = 30;
const URGENT_DAYS = 7;

function daysBetween(from: Date, to: Date): number {
  // Compare calendar dates, not instants — otherwise a case expiring later
  // today reads as "expired" purely because of the clock.
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

export function caseExpiry(
  caseData: { status?: string | null; end_date?: string | null },
  now: Date = new Date(),
): CaseExpiry {
  const endDate = caseData.end_date;
  if (!endDate) {
    return { tone: "projected", daysRemaining: null, relative: "—", highlight: false };
  }

  const days = daysBetween(now, new Date(endDate));

  const isLive = EXPIRY_RELEVANT_STATUSES.includes(
    (caseData.status ?? "") as (typeof EXPIRY_RELEVANT_STATUSES)[number],
  );
  if (!isLive) {
    return { tone: "projected", daysRemaining: days, relative: "not started", highlight: false };
  }

  if (days < 0) {
    const ago = Math.abs(days);
    return {
      tone: "past",
      daysRemaining: days,
      relative: `expired ${ago} day${ago === 1 ? "" : "s"} ago`,
      highlight: true,
    };
  }

  const relative = days === 0 ? "expires today" : `in ${days} day${days === 1 ? "" : "s"}`;
  if (days <= URGENT_DAYS) return { tone: "urgent", daysRemaining: days, relative, highlight: true };
  if (days <= SOON_DAYS) return { tone: "soon", daysRemaining: days, relative, highlight: true };
  return { tone: "ok", daysRemaining: days, relative, highlight: false };
}

/** Row tint. Empty string for tones that must not colour a row. */
export function expiryRowClass(tone: ExpiryTone): string {
  switch (tone) {
    case "past":
      return "bg-red-50 shadow-[inset_3px_0_0_theme(colors.red.600)]";
    case "urgent":
      return "bg-red-50/60 shadow-[inset_3px_0_0_theme(colors.red.500)]";
    case "soon":
      return "bg-amber-50 shadow-[inset_3px_0_0_theme(colors.amber.500)]";
    default:
      return "";
  }
}

/** Colour for the date and its relative phrase. */
export function expiryTextClass(tone: ExpiryTone): string {
  switch (tone) {
    case "past":
    case "urgent":
      return "text-red-700 font-medium";
    case "soon":
      return "text-amber-700 font-medium";
    case "projected":
      return "text-muted-foreground";
    default:
      return "";
  }
}
