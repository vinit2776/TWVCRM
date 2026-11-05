// Shaping for the leads calendar: which IST days a week covers, and how a list of follow-ups falls
// into days. Pure functions, so the day boundaries (the team's day is IST, not UTC) are tested.

import { istDayKey } from "@/lib/lead-days";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarItem {
  id: string;
  leadId: string;
  leadName: string;
  /** When the follow-up is due (ISO instant). */
  at: string;
  what: string;
  /** Activity type of the follow-up: a tour shows differently from a call. */
  type: string;
  handler: string | null;
  pinned: boolean;
}

/** "yyyy-MM-dd" plus a number of days. */
export function addDaysKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The seven IST days, Monday to Sunday, of the week that contains `key`. */
export function weekOf(key: string): string[] {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDaysKey(key, -((dow + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDaysKey(monday, i));
}

/** Items grouped by the IST day they fall on, each day's items in time order. */
export function bucketByDay(items: CalendarItem[]): Record<string, CalendarItem[]> {
  const out: Record<string, CalendarItem[]> = {};
  for (const item of [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    (out[istDayKey(item.at)] ??= []).push(item);
  }
  return out;
}

/** The UTC instants an IST day range [from, to] covers: start of `from`, start of the day after `to`. */
export function istRange(from: string, to: string): { start: string; end: string } {
  const offset = 330 * 60 * 1000;
  return {
    start: new Date(Date.parse(`${from}T00:00:00Z`) - offset).toISOString(),
    end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS - offset).toISOString(),
  };
}
