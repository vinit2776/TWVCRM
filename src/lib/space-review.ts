import { istDayKey } from "@/lib/lead-days";
import { waitingGroupLabel } from "@/lib/space-parking";

// The upkeep of Waiting for space: an enquiry that has waited a long time is asked about again, the
// "look again" date a person set becomes a reminder, and the list shows where the unmet demand is.

/** An enquiry untouched in Waiting for this many days is due a review, unless the setting says otherwise. */
export const DEFAULT_REVIEW_DAYS = 60;

export const REVIEW_MODES = ["off", "dry_run", "live"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
export function parseSpaceReviewMode(value: string | null | undefined): ReviewMode {
  return (REVIEW_MODES as readonly string[]).includes(value ?? "") ? (value as ReviewMode) : "dry_run";
}

/** The review interval from the setting; anything that is not a sensible whole number reads as the default. */
export function parseReviewDays(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 7 && n <= 365 ? n : DEFAULT_REVIEW_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole IST days from an instant to now. */
function daysSince(iso: string, now: Date): number {
  return Math.round((Date.parse(istDayKey(now)) - Date.parse(istDayKey(iso))) / DAY_MS);
}

/** When the last look at an enquiry was: its last review, or when it was parked. */
export function lastLookAt(parkedAt: string, lastReviewedAt: string | null | undefined): string {
  return lastReviewedAt ?? parkedAt;
}

/** Is the enquiry due a review? Counted from the last review (or from parking) in IST days. */
export function reviewDue(row: { parkedAt: string; lastReviewedAt?: string | null }, days: number, now: Date = new Date()): boolean {
  return daysSince(lastLookAt(row.parkedAt, row.lastReviewedAt), now) >= days;
}

/** Has the person's look-again date arrived (today or earlier)? */
export function lookAgainDue(lookAgainOn: string | null | undefined, now: Date = new Date()): boolean {
  return !!lookAgainOn && lookAgainOn <= istDayKey(now);
}

export interface DemandInput {
  locationName: string | null;
  otherArea: string | null;
  reason: string;
  seatsNeeded: number | null;
  parkedAt: string;
}
export interface DemandRow {
  group: string;
  waiting: number;
  seats: number;
  /** How many of the waiting enquiries said how many seats they need (the rest are left out of `seats`). */
  seatsKnown: number;
  oldestDays: number;
}

/** Where the demand we cannot meet is: waiting enquiries grouped by centre or area, biggest first. */
export function demandByArea(rows: DemandInput[], now: Date = new Date()): DemandRow[] {
  const map = new Map<string, DemandRow>();
  for (const r of rows) {
    const group = waitingGroupLabel({ locationName: r.locationName, otherArea: r.otherArea, reason: r.reason });
    const cur = map.get(group) ?? { group, waiting: 0, seats: 0, seatsKnown: 0, oldestDays: 0 };
    cur.waiting += 1;
    if (r.seatsNeeded) {
      cur.seats += r.seatsNeeded;
      cur.seatsKnown += 1;
    }
    cur.oldestDays = Math.max(cur.oldestDays, daysSince(r.parkedAt, now));
    map.set(group, cur);
  }
  return [...map.values()].sort((a, b) => b.waiting - a.waiting || b.seats - a.seats || a.group.localeCompare(b.group));
}
