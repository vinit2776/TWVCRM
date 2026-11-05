import { istDayKey } from "@/lib/lead-days";
import { nextStepChip, datePart, timePart, type NextStepState } from "@/lib/next-step-chip";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TourOutcome = "came" | "no_show" | "cancelled";
export const TOUR_OUTCOME_LABELS: Record<TourOutcome, string> = {
  came: "Came",
  no_show: "Didn't come",
  cancelled: "Cancelled",
};

/** The pills on the Tours tab. `legacy` is a past tour from before outcomes were recorded; it is
 *  listed under Done but never counted in the came / didn't come numbers. */
export type TourGroup = "needs_update" | "today" | "tomorrow" | "week" | "later" | "done";
export type TourBucket = TourGroup | "legacy";

export interface TourTiming {
  start: string;
  end: string | null;
  outcome: TourOutcome | null;
  /** Tours that started before this are never asked for an outcome. Null means none are. */
  cutoff: Date | null;
}

/** An hour is how long a booked tour runs when nobody says otherwise. */
function endOf(t: { start: string; end: string | null }): number {
  return Date.parse(t.end ?? "") || Date.parse(t.start) + 60 * 60 * 1000;
}

/** Which pill a tour belongs under, counted in IST days (the team's day, not the server's). */
export function tourBucket(t: TourTiming, now: Date = new Date()): TourBucket {
  if (t.outcome) return "done";
  if (endOf(t) <= now.getTime()) {
    // Past with nothing recorded: ask for it, unless it predates outcomes.
    return t.cutoff && Date.parse(t.start) >= t.cutoff.getTime() ? "needs_update" : "legacy";
  }
  const days = Math.round((Date.parse(istDayKey(t.start)) - Date.parse(istDayKey(now))) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

export interface TourChip {
  state: NextStepState | "past";
  big: string;
  when: string;
}

const dateTime = (iso: string) => `${datePart(iso)}, ${timePart(iso)}`;

/** How a tour's time reads on the row: "2 days ago" for one that needs an outcome, the usual day
 *  count for one that is still ahead. */
export function tourChip(t: TourTiming, now: Date = new Date()): TourChip {
  const bucket = tourBucket(t, now);
  if (bucket === "needs_update" || bucket === "legacy" || bucket === "done") {
    const days = Math.round((Date.parse(istDayKey(now)) - Date.parse(istDayKey(t.start))) / DAY_MS);
    const big = days <= 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;
    return { state: "past", big, when: dateTime(t.start) };
  }
  const c = nextStepChip(t.start, now);
  return { state: c.state, big: c.big, when: c.when };
}

export interface TourStats {
  total: number;
  came: number;
  noShow: number;
  cancelled: number;
  /** Tours that came and whose lead is now at a proposal, in negotiation or won. */
  convertedOfCame: number;
}

const ADVANCED_STATUSES = ["proposal_sent", "negotiating", "won"];

/** The numbers over a set of recorded tours. Legacy tours (no outcome) are left out. */
export function tourStats(rows: { outcome: TourOutcome | null; leadStatus: string }[]): TourStats {
  const stats: TourStats = { total: 0, came: 0, noShow: 0, cancelled: 0, convertedOfCame: 0 };
  for (const r of rows) {
    if (!r.outcome) continue;
    stats.total++;
    if (r.outcome === "came") {
      stats.came++;
      if (ADVANCED_STATUSES.includes(r.leadStatus)) stats.convertedOfCame++;
    } else if (r.outcome === "no_show") stats.noShow++;
    else stats.cancelled++;
  }
  return stats;
}

/** The sort and date-header order for a group: oldest first while something is waiting for an
 *  update or still ahead, newest first once it is done. */
export function tourSortAscending(group: TourGroup): boolean {
  return group !== "done";
}

/** How an outcome reads on the timeline. */
export function tourOutcomeSubject(outcome: TourOutcome): string {
  return outcome === "came" ? "Tour done" : outcome === "no_show" ? "Tour missed" : "Tour cancelled";
}
