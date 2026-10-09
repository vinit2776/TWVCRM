/**
 * Pure logic behind the dashboard Facilities widget: SLA state, the summary
 * lanes, age bands and the next-7-days strip. No I/O — safe to unit test.
 *
 * Everything keys off one thing: an issue's `sla_target_at`. Breach is computed
 * from that against "now" rather than read from the stored sla_breached flag,
 * so the widget cannot lag behind a clock the flag depends on a job to update.
 * An issue without an SLA target is never breached and never "expected".
 */

export const FACILITY_OPEN_STATUSES = ["new", "acknowledged", "in_progress", "reopened"] as const;
export const FACILITY_CLOSED_STATUSES = ["resolved", "closed"] as const;

export const FACILITY_SCOPES = ["hvac", "electrical", "plumbing", "housekeeping", "it", "security", "facility", "other"] as const;
export type FacilityWidgetScope = (typeof FACILITY_SCOPES)[number];

export const FACILITY_SCOPE_LABELS: Record<FacilityWidgetScope, string> = {
  hvac: "HVAC",
  electrical: "Electrical",
  plumbing: "Plumbing",
  housekeeping: "Housekeeping",
  it: "IT",
  security: "Security",
  facility: "Facility",
  other: "Other",
};

export const FACILITY_SCOPE_COLORS: Record<FacilityWidgetScope, string> = {
  hvac: "#378ADD",
  electrical: "#EF9F27",
  plumbing: "#1D9E75",
  housekeeping: "#D85A30",
  it: "#7F77DD",
  security: "#D4537E",
  facility: "#888780",
  other: "#B4B2A9",
};

export const FACILITY_PRIORITY_COLORS: Record<string, string> = {
  critical: "#E24B4A",
  high: "#EF9F27",
  medium: "#378ADD",
  low: "#B4B2A9",
};

export function normaliseScope(s: string | null | undefined): FacilityWidgetScope {
  return (FACILITY_SCOPES as readonly string[]).includes(s ?? "") ? (s as FacilityWidgetScope) : "other";
}

export interface FacilityWidgetItem {
  id: string;
  number: string;
  title: string;
  scope: FacilityWidgetScope;
  priority: string;
  status: string;
  /** reported_problem → "ticket", delegated_task → "task". */
  kind: "ticket" | "task";
  location: string | null;
  assignee: string | null;
  reported_at: string;
  last_activity: string;
  resolved_at: string | null;
  sla_target_at: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST_OFFSET = 5.5 * HOUR;

export const isOpen = (i: Pick<FacilityWidgetItem, "status">) =>
  (FACILITY_OPEN_STATUSES as readonly string[]).includes(i.status);

/** Whole IST calendar days since the epoch — the business's "today", not the browser's. */
export const istDay = (ms: number) => Math.floor((ms + IST_OFFSET) / DAY);

/** Hours until the SLA is due; negative once breached; null when there is no SLA. */
export function hoursToSla(i: Pick<FacilityWidgetItem, "sla_target_at">, nowMs: number): number | null {
  if (!i.sla_target_at) return null;
  return (Date.parse(i.sla_target_at) - nowMs) / HOUR;
}

export type SlaState = "breached" | "due_soon" | "on_track" | "no_sla" | "closed";
export const DUE_SOON_HOURS = 6;

export function slaState(i: FacilityWidgetItem, nowMs: number): SlaState {
  if (!isOpen(i)) return "closed";
  const h = hoursToSla(i, nowMs);
  if (h == null) return "no_sla";
  if (h < 0) return "breached";
  return h <= DUE_SOON_HOURS ? "due_soon" : "on_track";
}

export const isBreached = (i: FacilityWidgetItem, nowMs: number) => slaState(i, nowMs) === "breached";

/** SLA falls later today (IST) and has not yet been missed. */
export function isDueToday(i: FacilityWidgetItem, nowMs: number): boolean {
  if (!isOpen(i) || !i.sla_target_at) return false;
  const due = Date.parse(i.sla_target_at);
  return due >= nowMs && istDay(due) === istDay(nowMs);
}

/** 0 = today … 6 = six days out, for open, not-yet-breached issues; null otherwise. */
export function expectedDayOffset(i: FacilityWidgetItem, nowMs: number): number | null {
  if (!isOpen(i) || !i.sla_target_at) return null;
  const due = Date.parse(i.sla_target_at);
  if (due < nowMs) return null;
  const off = istDay(due) - istDay(nowMs);
  return off >= 0 && off <= 6 ? off : null;
}

export const AGE_BANDS = ["< 1 day", "1–3 days", "3–7 days", "> 7 days"] as const;

export function ageBand(i: Pick<FacilityWidgetItem, "reported_at">, nowMs: number): number {
  const h = (nowMs - Date.parse(i.reported_at)) / HOUR;
  return h < 24 ? 0 : h < 72 ? 1 : h < 168 ? 2 : 3;
}

export const FACILITY_LANES = ["pending", "new", "in_progress", "breached", "today", "reopened", "done"] as const;
export type FacilityLane = (typeof FACILITY_LANES)[number];

export const FACILITY_LANE_LABELS: Record<FacilityLane, { label: string; hint: string }> = {
  pending: { label: "Open now", hint: "" },
  new: { label: "Unclaimed", hint: "need an owner" },
  in_progress: { label: "In progress", hint: "being worked" },
  breached: { label: "SLA breached", hint: "past due" },
  today: { label: "Due today", hint: "later today" },
  reopened: { label: "Reopened", hint: "came back" },
  done: { label: "Resolved · 7 d", hint: "closed out" },
};

export function inLane(lane: FacilityLane, i: FacilityWidgetItem, nowMs: number): boolean {
  switch (lane) {
    case "pending": return isOpen(i);
    case "new": return i.status === "new";
    case "in_progress": return i.status === "in_progress";
    case "breached": return isBreached(i, nowMs);
    case "today": return isDueToday(i, nowMs);
    case "reopened": return i.status === "reopened";
    case "done": return !isOpen(i);
  }
}

export interface FacilityFilter {
  kind: "all" | "ticket" | "task";
  lane: FacilityLane;
  scope: FacilityWidgetScope | null;
  ageBand: number | null;
  /** Day offset from the Expected strip. */
  day: number | null;
}

/** Items matching the active filters. Feed order: most recent activity first, most overdue first on the breach lane. */
export function applyFilter(items: FacilityWidgetItem[], f: FacilityFilter, nowMs: number): FacilityWidgetItem[] {
  return items
    .filter((i) => f.kind === "all" || i.kind === f.kind)
    .filter((i) => inLane(f.lane, i, nowMs))
    .filter((i) => !f.scope || i.scope === f.scope)
    .filter((i) => f.ageBand == null || (isOpen(i) && ageBand(i, nowMs) === f.ageBand))
    .filter((i) => f.day == null || expectedDayOffset(i, nowMs) === f.day)
    .sort((a, b) =>
      f.lane === "breached"
        ? (hoursToSla(a, nowMs) ?? 0) - (hoursToSla(b, nowMs) ?? 0)
        : Date.parse(b.last_activity) - Date.parse(a.last_activity)
    );
}

/** Compact "3h" / "2d" / "40m" for a span in hours. */
export function fmtHours(h: number): string {
  const a = Math.abs(h);
  if (a < 1) return `${Math.max(1, Math.round(a * 60))}m`;
  if (a < 48) return `${Math.round(a)}h`;
  return `${Math.round(a / 24)}d`;
}
