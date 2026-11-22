import { istDayKey } from "@/lib/lead-days";

// Parking an enquiry we cannot offer yet. Pure rules shared by the routes and the screens.

export const PARK_REASONS = ["not_open", "no_space_of_size", "other"] as const;
export type ParkReason = (typeof PARK_REASONS)[number];
export const PARK_REASON_LABELS: Record<ParkReason, string> = {
  not_open: "That centre is not open yet",
  no_space_of_size: "No space of the size they need",
  other: "Something else",
};

export interface ParkInput {
  locationId: string | null | undefined;
  otherArea: string | null | undefined;
  reason: string | null | undefined;
  note: string | null | undefined;
  lookAgainOn: string | null | undefined;
  seatsNeeded?: number | null;
}

/** What is missing from a park request, in plain words; null when it can go ahead. */
export function parkProblem(p: ParkInput, now: Date = new Date()): string | null {
  if (!p.locationId && !(p.otherArea ?? "").trim()) return "Say where they want space: pick a centre, or name the area";
  if (!p.reason || !(PARK_REASONS as readonly string[]).includes(p.reason)) return "Pick why we cannot offer it yet";
  if (!(p.note ?? "").trim() || (p.note ?? "").trim().length < 3) return "Add a note about what they want";
  if (p.seatsNeeded != null && (!Number.isInteger(p.seatsNeeded) || p.seatsNeeded < 1 || p.seatsNeeded > 500)) return "Seats must be a whole number";
  if (p.lookAgainOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.lookAgainOn)) return "That look-again date is not valid";
    if (p.lookAgainOn <= istDayKey(now)) return "Pick a look-again date after today";
  }
  return null;
}

export interface ReleaseInput {
  nextStep: string | null | undefined;
  followUpDate: string | null | undefined;
}

/** Taking an enquiry out of Waiting needs the next step, so it never comes back to nothing. */
export function releaseProblem(r: ReleaseInput, now: Date = new Date()): string | null {
  if (!(r.nextStep ?? "").trim()) return "Say what the next step is";
  if (!r.followUpDate) return "Pick when to do it";
  const t = Date.parse(r.followUpDate);
  if (Number.isNaN(t)) return "That date is not valid";
  if (istDayKey(new Date(t)) < istDayKey(now)) return "Pick today or a later date";
  return null;
}

/** Whole days an enquiry has been waiting (IST days). */
export function daysWaiting(parkedAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.round((Date.parse(istDayKey(now)) - Date.parse(istDayKey(parkedAt))) / (24 * 60 * 60 * 1000)));
}

/** The group a waiting enquiry sits under: the centre, or the area we have no centre in. */
export function waitingGroupLabel(row: { locationName: string | null; otherArea: string | null; reason: string }): string {
  const where = row.locationName ?? row.otherArea ?? "Somewhere else";
  if (row.reason === "not_open") return `${where} (not open)`;
  if (row.reason === "no_space_of_size") return `${where}: no space of this size`;
  return where;
}
