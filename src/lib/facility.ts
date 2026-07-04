/**
 * Facility Issues — shared helpers
 *
 * Centralises the bits of logic that need to stay consistent across
 * API routes, cron jobs and (eventually) bulk-import scripts:
 *
 *   - Issue number generation        (e.g. "IT-2026-00042")
 *   - SLA target computation         (priority + category defaults → ISO timestamp)
 *   - Status transition guard rails  (next allowed states + side-effects)
 *   - Event timeline writer          (one helper, used everywhere)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type {
  FacilityIssuePriority,
  FacilityIssueStatus,
  FacilityScope,
  FacilityAssetCategory,
} from "@/types";

const SCOPE_PREFIX: Record<FacilityScope, string> = {
  it: "IT",
  hvac: "HV",
  plumbing: "PL",
  electrical: "EL",
  housekeeping: "HK",
  security: "SC",
  other: "OT",
  facility: "FA",
};

/**
 * Generate the next issue number for a given scope and year.
 *
 * Strategy: look up the highest existing N for this scope/year and add 1.
 * The issue_number column has a UNIQUE constraint, so on the very rare
 * concurrent insert collision, the second insert will 23505 and the route
 * caller can retry.
 *
 * Format: {SCOPE_PREFIX}-{YYYY}-{NNNNN}   e.g. "IT-2026-00042"
 */
export async function generateIssueNumber(
  supabase: SupabaseClient,
  scope: FacilityScope,
  year: number = new Date().getFullYear()
): Promise<string> {
  const prefix = SCOPE_PREFIX[scope] ?? "IS";
  const yearPrefix = `${prefix}-${year}-`;

  const { data } = await supabase
    .from("facility_issues")
    .select("issue_number")
    .like("issue_number", `${yearPrefix}%`)
    .order("issue_number", { ascending: false })
    .limit(1);

  let n = 1;
  if (data && data.length > 0) {
    const last = String(data[0].issue_number || "");
    const m = last.match(/-(\d+)$/);
    if (m) n = Number(m[1]) + 1;
  }

  return `${yearPrefix}${String(n).padStart(5, "0")}`;
}

/**
 * Compute SLA target timestamp from priority + category defaults.
 * Returns ISO string for direct insert.
 */
export function computeSlaTarget(
  category: Pick<
    FacilityAssetCategory,
    "default_sla_critical_hrs" | "default_sla_high_hrs" | "default_sla_medium_hrs" | "default_sla_low_hrs"
  >,
  priority: FacilityIssuePriority,
  reportedAt: Date = new Date()
): string {
  const hoursMap: Record<FacilityIssuePriority, number> = {
    critical: Number(category.default_sla_critical_hrs) || 2,
    high: Number(category.default_sla_high_hrs) || 8,
    medium: Number(category.default_sla_medium_hrs) || 24,
    low: Number(category.default_sla_low_hrs) || 72,
  };
  const target = new Date(reportedAt.getTime() + hoursMap[priority] * 3600 * 1000);
  return target.toISOString();
}

/**
 * Can `delegator` delegate a task to `assignee`?
 *
 * v1: any active user can delegate to any other active user — a
 * location-scoped model (via user_locations) was designed but dropped
 * before implementation because user_locations is populated for only
 * 2 of 15 active users today (inventory/transfer scoping, not an org
 * chart). Revisit scoping this once user_locations coverage improves;
 * keeping this as a named function (not an inline check) is what makes
 * that a one-function change later instead of a route rewrite.
 */
export function canDelegateTo(assignee: { is_active: boolean } | null | undefined): boolean {
  return !!assignee?.is_active;
}

/**
 * Compute the time-to-claim SLA deadline from priority.
 * Hardcoded targets: critical=2h, high=4h, medium=8h, low=24h.
 */
export function computeClaimSlaTarget(
  priority: FacilityIssuePriority,
  reportedAt: Date = new Date()
): string {
  const hoursMap: Record<FacilityIssuePriority, number> = {
    critical: 2,
    high: 4,
    medium: 8,
    low: 24,
  };
  const target = new Date(reportedAt.getTime() + hoursMap[priority] * 3600 * 1000);
  return target.toISOString();
}

/**
 * What status transitions are allowed? Used by the PATCH /status route to
 * reject bogus transitions early with a clear error.
 */
export const ALLOWED_TRANSITIONS: Record<FacilityIssueStatus, FacilityIssueStatus[]> = {
  new: ["acknowledged", "in_progress", "resolved", "closed"],
  acknowledged: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "acknowledged", "closed"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["acknowledged", "in_progress", "resolved", "closed"],
};

export function canTransition(from: FacilityIssueStatus, to: FacilityIssueStatus): boolean {
  if (from === to) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Write a row to facility_issue_events. Fire-and-forget — failures shouldn't
 * block the main mutation, but we await so multiple events stay in order.
 */
export async function logIssueEvent(
  supabase: SupabaseClient,
  params: {
    issueId: string;
    eventType: string;
    actorId?: string | null;
    actorLabel?: string | null;
    message?: string | null;
    payload?: Record<string, unknown>;
  }
) {
  await supabase.from("facility_issue_events").insert({
    issue_id: params.issueId,
    event_type: params.eventType,
    actor_id: params.actorId ?? null,
    actor_label: params.actorLabel ?? null,
    message: params.message ?? null,
    payload: params.payload ?? {},
  });
}

/**
 * Apply timestamp side-effects for a status change.
 * Returns the partial row to UPDATE.
 */
export function timestampsForStatus(
  to: FacilityIssueStatus,
  current: {
    acknowledged_at?: string | null;
    started_at?: string | null;
    resolved_at?: string | null;
    closed_at?: string | null;
  }
): Record<string, string | null> {
  const now = new Date().toISOString();
  const out: Record<string, string | null> = {};
  switch (to) {
    case "acknowledged":
      if (!current.acknowledged_at) out.acknowledged_at = now;
      break;
    case "in_progress":
      if (!current.acknowledged_at) out.acknowledged_at = now;
      if (!current.started_at) out.started_at = now;
      break;
    case "resolved":
      if (!current.acknowledged_at) out.acknowledged_at = now;
      if (!current.started_at) out.started_at = now;
      out.resolved_at = now;
      break;
    case "closed":
      out.closed_at = now;
      if (!current.resolved_at) out.resolved_at = now;
      break;
    case "reopened":
      out.resolved_at = null;
      out.closed_at = null;
      break;
  }
  return out;
}

/** Compute resolution time in minutes between acknowledged and resolved. */
export function resolutionMinutes(ackAt?: string | null, resolvedAt?: string | null): number | null {
  if (!ackAt || !resolvedAt) return null;
  const a = new Date(ackAt).getTime();
  const r = new Date(resolvedAt).getTime();
  if (!isFinite(a) || !isFinite(r) || r < a) return null;
  return Math.round((r - a) / 60000);
}

/** Was the issue resolved within its SLA target? */
export function metSla(slaTargetAt?: string | null, resolvedAt?: string | null): boolean | null {
  if (!slaTargetAt || !resolvedAt) return null;
  return new Date(resolvedAt).getTime() <= new Date(slaTargetAt).getTime();
}

/** Roles allowed to perform a given action — used in route guards. */
export const FACILITY_ROLES = {
  manage: ["admin", "it_manager", "it_team"] as const,
  workOnIssues: ["admin", "manager", "it_manager", "it_technician", "it_team", "fms", "office_admin", "floor_manager"] as const,
  // Anyone authenticated can report.
};

export function hasRole(userRole: string | undefined, allowed: readonly string[]): boolean {
  return !!userRole && allowed.includes(userRole);
}
