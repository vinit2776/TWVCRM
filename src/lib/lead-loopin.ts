// Keep informed: a colleague is asked to see a lead without being given a job. It clears itself
// after LOOPIN_DAYS, and the colleague can answer earlier. One definition, so the lead page, the
// Home card and the routes agree.

export const LOOPIN_DAYS = 14;
export const LOOPIN_MIN_REASON = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Only people who work leads can be kept informed (a floor manager or IT technician has no lead screens). */
export function canBeKeptInformed(role: string | null | undefined, handlerRoles: readonly string[]): boolean {
  return !!role && handlerRoles.includes(role);
}

export function loopinExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + LOOPIN_DAYS * DAY_MS).toISOString();
}

/** Why a request cannot be made, or null. */
export function loopinProblem(input: { userIds: string[]; reason: string | null | undefined; addedBy: string }): string | null {
  if (input.userIds.length === 0) return "Pick at least one person";
  if (input.userIds.includes(input.addedBy)) return "You cannot keep yourself informed";
  if ((input.reason ?? "").trim().length < LOOPIN_MIN_REASON) return "Say why they are kept informed";
  return null;
}

export type WatcherState = "waiting" | "got_it" | "not_for_me" | "expired";

export interface WatcherRow {
  answer: string | null;
  expires_at: string;
}

export function watcherState(row: WatcherRow, now: Date = new Date()): WatcherState {
  if (row.answer === "got_it") return "got_it";
  if (row.answer === "not_for_me") return "not_for_me";
  return Date.parse(row.expires_at) <= now.getTime() ? "expired" : "waiting";
}

/** Whole days left before it clears itself (never below 0). */
export function daysLeft(expiresAt: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / DAY_MS));
}
