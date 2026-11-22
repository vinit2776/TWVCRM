import { NON_EVENT_SUBJECTS } from "@/lib/lead-stale";

// The escalation ladder for an enquiry nobody has touched. The clock runs on working time only
// (Mon to Sat, 9am to 7pm IST), so an enquiry that arrives at 10pm starts its 45 minutes at 9am and
// nobody is pinged at night. The ladder climbs while it stays untouched: the owner (or the whole sales
// pool when nobody has taken it), then the other sales people, then the managers. Staff only; none of
// this ever contacts a customer.

export const ESCALATION_TARGET_MINUTES = 45;

export const ESCALATION_RUNGS = [
  { rung: "owner", afterMinutes: ESCALATION_TARGET_MINUTES },
  { rung: "sales", afterMinutes: ESCALATION_TARGET_MINUTES * 2 },
  { rung: "manager", afterMinutes: ESCALATION_TARGET_MINUTES * 4 },
] as const;
export type EscalationRung = (typeof ESCALATION_RUNGS)[number]["rung"];

/** Working hours in IST: Monday to Saturday, from this hour to that hour. */
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 19;

/** `off` does nothing, `dry_run` only reports what it would send, `live` sends. Unknown reads as dry_run. */
export const ESCALATION_MODES = ["off", "dry_run", "live"] as const;
export type EscalationMode = (typeof ESCALATION_MODES)[number];
export function parseEscalationMode(value: string | null | undefined): EscalationMode {
  return (ESCALATION_MODES as readonly string[]).includes(value ?? "") ? (value as EscalationMode) : "dry_run";
}

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const IST_OFFSET_MS = 330 * MIN_MS;
/** A forgotten enquiry is not chased forever: past this many days the ladder lets go of it. */
export const ESCALATION_MAX_DAYS = 14;

/**
 * Minutes of working time between two instants. Shifted into IST so a day boundary and the working
 * window mean the team's day, not the server's. Sundays count for nothing.
 */
export function workingMinutesBetween(fromIso: string | Date, to: Date = new Date()): number {
  const from = new Date(fromIso).getTime() + IST_OFFSET_MS;
  const end = to.getTime() + IST_OFFSET_MS;
  if (!(end > from)) return 0;
  let total = 0;
  // Start at the IST midnight of the first day; the cap keeps a bad date from looping for years.
  let dayStart = Math.floor(from / DAY_MS) * DAY_MS;
  for (let i = 0; dayStart < end && i <= ESCALATION_MAX_DAYS * 4; i += 1, dayStart += DAY_MS) {
    const weekday = new Date(dayStart).getUTCDay(); // 0 = Sunday
    if (weekday === 0) continue;
    const open = dayStart + WORK_START_HOUR * 60 * MIN_MS;
    const close = dayStart + WORK_END_HOUR * 60 * MIN_MS;
    const overlap = Math.min(close, end) - Math.max(open, from);
    if (overlap > 0) total += overlap / MIN_MS;
  }
  return Math.floor(total);
}

/** The highest rung an enquiry has reached after this much working time, or null while it is inside the target. */
export function rungReached(workedMinutes: number): EscalationRung | null {
  let reached: EscalationRung | null = null;
  for (const r of ESCALATION_RUNGS) if (workedMinutes >= r.afterMinutes) reached = r.rung;
  return reached;
}

/**
 * The first moment someone dealt with the enquiry: a call, reply or note logged on the lead, or an
 * update on the enquiry itself, at or after it arrived. The notes the system writes when a lead
 * changes hands, and merely taking the enquiry on, do not count, so nobody quiets the ladder by
 * claiming it and walking away. Null while nothing has happened.
 */
export function firstTouchAt(receivedAt: string, events: { at: string; subject?: string | null }[]): string | null {
  const received = Date.parse(receivedAt);
  let first: string | null = null;
  for (const e of events) {
    if ((NON_EVENT_SUBJECTS as readonly string[]).includes(e.subject ?? "")) continue;
    const t = Date.parse(e.at);
    if (Number.isNaN(t) || t < received) continue;
    if (first === null || t < Date.parse(first)) first = e.at;
  }
  return first;
}

export interface EscalationPeople {
  /** Whoever took the enquiry on, if anyone. */
  ownerId: string | null;
  salesIds: string[];
  managerIds: string[];
}

/** Who hears about the rung: the owner (or the pool when unclaimed), the other sales people, the managers. */
export function rungRecipients(rung: EscalationRung, people: EscalationPeople): string[] {
  const pool = [...new Set(people.salesIds)];
  if (rung === "owner") return people.ownerId ? [people.ownerId] : pool;
  if (rung === "sales") return pool.filter((id) => id !== people.ownerId);
  return [...new Set(people.managerIds)];
}

export const RUNG_TITLE: Record<EscalationRung, string> = {
  owner: "Enquiry waiting",
  sales: "Enquiry still waiting",
  manager: "Enquiry untouched",
};

export function rungMessage(rung: EscalationRung, reference: string, name: string, workedMinutes: number) {
  const mins = Math.floor(workedMinutes);
  const wait = mins >= 120 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return {
    // The title is also the dedupe key, so each rung of each enquiry alerts once.
    title: `${RUNG_TITLE[rung]}: ${reference} — ${name}`,
    body: `Nobody has called or replied yet (${wait} of working time). Take it on, then log the call or tap Replied.`,
  };
}
