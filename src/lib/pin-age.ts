import { istDayKey } from "@/lib/lead-days";

// A pin keeps a lead in front of the team, but a pin nobody has touched for a fortnight is probably
// forgotten, and it also exempts the lead from going stale. This is the one definition of "a pin gone
// quiet", so the list, the lead page and the Home card agree.

export const PIN_QUIET_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PinState {
  /** Whole IST days since it was pinned. */
  daysPinned: number;
  /** Whole IST days since the later of pinning and the last real activity on the lead. */
  daysQuiet: number;
  quiet: boolean;
}

/**
 * Where a pin stands. `lastActivityAt` is the last thing someone really did on the lead (a call, a
 * note, a tour; not the system's own notes). Quiet counts from the later of that and the pin itself,
 * so pinning a lead is itself a look at it.
 */
export function pinState(pinnedAt: string, lastActivityAt: string | null | undefined, now: Date = new Date()): PinState {
  const days = (iso: string) => Math.max(0, Math.round((Date.parse(istDayKey(now)) - Date.parse(istDayKey(iso))) / DAY_MS));
  const since = lastActivityAt && Date.parse(lastActivityAt) > Date.parse(pinnedAt) ? lastActivityAt : pinnedAt;
  const daysQuiet = days(since);
  return { daysPinned: days(pinnedAt), daysQuiet, quiet: daysQuiet >= PIN_QUIET_DAYS };
}

/** What the row says about a pin: "Pinned 18 days", and "no activity for 15 days" once it has gone quiet. */
export function pinLabel(s: PinState): { text: string; quiet: boolean } {
  const pinned = `Pinned ${s.daysPinned} day${s.daysPinned === 1 ? "" : "s"}`;
  return s.quiet ? { text: `${pinned} · no activity for ${s.daysQuiet} days`, quiet: true } : { text: s.daysPinned === 0 ? "Pinned today" : pinned, quiet: false };
}
