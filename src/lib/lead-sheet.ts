/**
 * Rules for the Leads sheet: one row per lead, coloured by where it stands, grouped by the day it
 * came in. Pure functions only, so the colours, the "not attended" call and the day folding can be
 * tested without a screen.
 */

export type SheetStatus = "none" | "spoke" | "noanswer" | "tour" | "quote" | "won" | "lost" | "junk";

export interface SheetStatusMeta {
  label: string;
  hint: string;
  /** Row background and the bar on its left edge. */
  bg: string;
  bar: string;
}

/** The colour scheme, in the order the guide lists it. */
export const SHEET_STATUSES: SheetStatus[] = ["none", "spoke", "noanswer", "tour", "quote", "won", "lost", "junk"];

export const SHEET_STATUS_META: Record<SheetStatus, SheetStatusMeta> = {
  none: { label: "Not attended", hint: "Nobody has acted yet. Needs a call now.", bg: "#ffe1dc", bar: "#d92d20" },
  spoke: { label: "Spoke", hint: "Reached; waiting on the next step", bg: "#e4effc", bar: "#3b82d6" },
  noanswer: { label: "No answer", hint: "Tried, not reached; retry due", bg: "#fff3c8", bar: "#e0a800" },
  tour: { label: "Tour booked", hint: "Visit planned", bg: "#efe6fb", bar: "#8a52d6" },
  quote: { label: "Quote / proposal sent", hint: "Waiting on the customer", bg: "#dcf3f1", bar: "#17a398" },
  won: { label: "Won", hint: "Contract activated", bg: "#d6f2dc", bar: "#1f9d43" },
  lost: { label: "Lost / not interested", hint: "Closed", bg: "#f3e3e3", bar: "#b98a8a" },
  junk: { label: "Junk", hint: "Not a real enquiry", bg: "#f1f2f4", bar: "#b9bec6" },
};

/** The slice of a lead the sheet reads. */
export interface SheetLeadInput {
  status: string;
  created_at: string;
  assigned_user?: { full_name?: string | null } | null;
  _last_contact?: { subject: string; at: string; note: string | null; by?: string | null } | null;
}

const BY_SUBJECT: Record<string, SheetStatus> = {
  Spoke: "spoke",
  "No answer": "noanswer",
  "Tour booked": "tour",
  "Quote sent": "quote",
};

/**
 * Where a lead stands. Closed outcomes win, then a proposal that has gone out (set by the system
 * when it is sent), then the last thing a person logged, then what the status implies.
 */
export function sheetStatus(lead: SheetLeadInput): SheetStatus {
  const s = lead.status;
  if (s === "won") return "won";
  if (s === "lost") return "lost";
  if (s === "junk") return "junk";
  if (s === "proposal_sent" || s === "negotiating") return "quote";
  const logged = lead._last_contact ? BY_SUBJECT[lead._last_contact.subject] : undefined;
  if (logged) return logged;
  // A logged contact with a free-text subject ("Tour (tomorrow)", "Call"): the status says what it was.
  if (s === "tour_scheduled" || s === "tour_completed") return "tour";
  if (s === "contacted" || lead._last_contact) return "spoke";
  return "none";
}

export interface SheetLastAction {
  label: string;
  by: string | null;
  at: string | null;
  /** Set by the system (proposal sent, contract activated), not by a button. */
  auto: boolean;
}

/** The "last action" cell: what happened, who did it, when. Null when nobody has acted. */
export function sheetLastAction(lead: SheetLeadInput): SheetLastAction | null {
  const owner = lead.assigned_user?.full_name ?? null;
  const st = lead.status;
  if (st === "won") return { label: "Won", by: owner, at: lead._last_contact?.at ?? null, auto: true };
  if (st === "proposal_sent" || st === "negotiating") {
    return { label: "Proposal sent", by: owner, at: lead._last_contact?.at ?? null, auto: true };
  }
  if (lead._last_contact) {
    return { label: lead._last_contact.subject, by: lead._last_contact.by ?? owner, at: lead._last_contact.at, auto: false };
  }
  // Moved on by the system or another screen without a logged call: the status still says someone acted.
  if (st === "tour_scheduled") return { label: "Tour booked", by: owner, at: null, auto: false };
  if (st === "tour_completed") return { label: "Tour done", by: owner, at: null, auto: false };
  if (st === "contacted") return { label: "Contacted", by: owner, at: null, auto: false };
  if (st === "lost") return { label: "Not interested", by: owner, at: null, auto: false };
  if (st === "junk") return { label: "Marked junk", by: owner, at: null, auto: false };
  return null;
}

const IST_MS = 330 * 60 * 1000;

/** The IST calendar day (yyyy-MM-dd) of an instant. */
export function istDay(iso: string | number | Date): string {
  return new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromDay` to `toDay` (both yyyy-MM-dd). */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000);
}

export interface DayGroup<T> {
  day: string;
  rows: T[];
}

/** Rows in the order given, split into one group per IST day they were created on. */
export function groupByDay<T extends { created_at: string }>(rows: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const r of rows) {
    const day = istDay(r.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  return groups;
}

/** Days older than this start folded, while nothing is filtered. */
export const FOLD_AFTER_DAYS = 7;

export function startsFolded(day: string, today: string, filtering: boolean): boolean {
  return !filtering && daysBetween(day, today) > FOLD_AFTER_DAYS;
}

/** "Today", "Yesterday", or the weekday and date, for a day header. */
export function dayHeading(day: string, today: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const text = d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", timeZone: "UTC" });
  const gap = daysBetween(day, today);
  return gap === 0 ? `Today · ${text}` : gap === 1 ? `Yesterday · ${text}` : text;
}

/** How long an enquiry has waited, as "35 min", "5 h" or "3 d". */
export function waitingText(createdAt: string, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - new Date(createdAt).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export interface SheetFilters {
  /** Only leads nobody has acted on. */
  notContacted: boolean;
  /** Last action label, or "" for any. */
  lastAction: string;
  /** Statuses picked in the colour guide; empty means all. */
  statuses: SheetStatus[];
}

export function filtersActive(f: SheetFilters, extra: { center: string; channel: string; owner: string }): boolean {
  return f.notContacted || !!f.lastAction || f.statuses.length > 0 || !!extra.center || !!extra.channel || !!extra.owner;
}

export function passesSheetFilters(lead: SheetLeadInput, f: SheetFilters, opts: { skipStatuses?: boolean } = {}): boolean {
  const last = sheetLastAction(lead);
  if (f.notContacted && last) return false;
  if (f.lastAction && last?.label !== f.lastAction) return false;
  if (!opts.skipStatuses && f.statuses.length > 0 && !f.statuses.includes(sheetStatus(lead))) return false;
  return true;
}

/** The choices in the Last action filter. */
export const LAST_ACTION_CHOICES = ["Spoke", "No answer", "Tour booked", "Quote sent", "Proposal sent", "Won", "Not interested"];
