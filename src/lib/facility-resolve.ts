import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import {
  canTransition, timestampsForStatus, resolutionMinutes, metSla, logIssueEvent,
} from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import { computeKpiPoints, writeKpiCredits } from "@/lib/facility-kpi";
import type { FacilityIssueStatus, FacilityIssuePriority, FacilityRootCause } from "@/types";

/**
 * Everything that has to happen when a facility issue becomes `resolved`.
 *
 * There are two routes into this state — the status endpoint and "log an
 * event on the asset, and tick resolve" — and they had drifted badly: the
 * asset-event path set three columns and stopped, so those tickets carried
 * no resolution time, never had their SLA evaluated, earned no KPI points,
 * never requested a satisfaction rating, and notified nobody. Since the Team
 * KPI report is used for appraisals, that undercounted whoever resolved work
 * that way and overstated SLA compliance (see issue #759).
 *
 * Both callers now go through here, so the two paths can't drift again.
 */

export type ResolveActor = {
  /** public.users.id — audit_trail and facility_issue_events reference this */
  id: string;
  /** auth.users.id — facility_asset_events.logged_by references this instead */
  authId: string;
  fullName: string | null;
};

export type ResolveIssueInput = {
  issueId: string;
  actor: ResolveActor;
  resolutionNotes?: string | null;
  rootCause?: FacilityRootCause | null;
  partsCost?: number | null;
  partsNotes?: string | null;
  /**
   * The asset-event route has already written the event that triggered this,
   * so it passes false — otherwise resolving from an asset event would log a
   * second, duplicate maintenance event against the same asset.
   */
  logAssetEvent: boolean;
};

export type ResolveIssueResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

const VALID_ROOT: FacilityRootCause[] = [
  "hardware_failure", "config_issue", "isp_outage", "power_issue",
  "user_error", "scheduled_maintenance", "wear_and_tear",
  "environmental", "unknown", "other",
];

export async function resolveIssue(
  supabase: SupabaseClient,
  input: ResolveIssueInput,
): Promise<ResolveIssueResult> {
  const { issueId, actor } = input;

  const { data: existing, error: loadErr } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, status, priority, category_id, asset_id, assigned_to, reported_by, scope, acknowledged_at, started_at, resolved_at, closed_at, sla_target_at, sla_breached, reopen_count, reporter_email, satisfaction_token")
    .eq("id", issueId)
    .single();
  if (loadErr || !existing) return { ok: false, status: 404, error: "Not found" };

  const from = existing.status as FacilityIssueStatus;
  if (!canTransition(from, "resolved")) {
    return { ok: false, status: 400, error: `Cannot transition from ${from} to resolved` };
  }

  const tsUpdates = timestampsForStatus("resolved", existing);
  const updates: Record<string, unknown> = { status: "resolved", ...tsUpdates };

  if (input.resolutionNotes != null) updates.resolution_notes = String(input.resolutionNotes);
  if (input.rootCause && VALID_ROOT.includes(input.rootCause)) {
    updates.resolution_root_cause = input.rootCause;
  }
  if (input.partsCost != null) updates.parts_cost = Number(input.partsCost) || 0;
  if (input.partsNotes != null) updates.parts_notes = String(input.partsNotes);

  const ackAt = (tsUpdates.acknowledged_at ?? existing.acknowledged_at) as string | null;
  const resolvedAt = tsUpdates.resolved_at as string;
  updates.resolution_time_minutes = resolutionMinutes(ackAt, resolvedAt);

  const within = metSla(existing.sla_target_at, resolvedAt);
  if (within !== null) updates.sla_breached = !within;

  // Mark for satisfaction request
  updates.satisfaction_requested_at = new Date().toISOString();

  // KPI score — satisfaction isn't known yet (requested just above), so this
  // is the base score; the satisfaction endpoint tops it up once a rating
  // comes in (or recomputes on an auto-reopen from a low rating).
  const { data: exts } = await supabase
    .from("facility_issue_tat_extensions")
    .select("kpi_exempt")
    .eq("issue_id", issueId);
  const kpiResult = computeKpiPoints({
    priority: existing.priority as FacilityIssuePriority,
    slaBreached: (updates.sla_breached ?? existing.sla_breached ?? false) as boolean,
    reopenCount: existing.reopen_count ?? 0,
    satisfactionRating: null,
    extensionExemptFlags: (exts ?? []).map((e) => e.kpi_exempt),
  });
  updates.kpi_points = kpiResult.total;
  updates.kpi_breakdown = kpiResult.lines;

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", issueId).select().single();
  if (error) return { ok: false, status: 500, error: error.message };

  if (updates.kpi_points != null) {
    await writeKpiCredits(supabase, {
      issueId,
      scope: existing.scope as string,
      assignedTo: existing.assigned_to,
      total: updates.kpi_points as number,
    });
  }

  await logIssueEvent(supabase, {
    issueId,
    eventType: "resolved",
    actorId: actor.id,
    actorLabel: actor.fullName,
    message: `Status: ${from} → resolved`,
    payload: {
      from, to: "resolved",
      ...(updates.resolution_root_cause ? { root_cause: updates.resolution_root_cause } : {}),
    },
  });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: issueId, action: "update",
    performedBy: actor.id,
    changes: { status: { old: from, new: "resolved" } },
  });

  await notifyIssueAssignee(
    {
      id: issueId, category_id: existing.category_id, assigned_to: existing.assigned_to,
      issue_number: existing.issue_number, title: existing.title,
    },
    {
      type: "status_changed", from, to: "resolved", actorName: actor.fullName ?? "",
      reporterEmail: existing.reporter_email ?? null,
      satisfactionToken: existing.satisfaction_token ?? null,
      reportedByUserId: existing.reported_by ?? null,
    },
  );

  // Auto-log a maintenance event on the linked asset. logged_by references
  // auth.users(id), not public.users(id) — passing the latter fails the
  // foreign key, and this insert has no error check, so it failed silently
  // every time a ticket was resolved the normal way.
  if (input.logAssetEvent && existing.asset_id) {
    const { error: evErr } = await supabase.from("facility_asset_events").insert({
      asset_id: existing.asset_id,
      event_type: "maintenance",
      note: `Resolved via ${existing.issue_number}: ${existing.title}`,
      logged_by: actor.authId,
      issue_id: issueId,
    });
    if (evErr) {
      console.error(`[facility-resolve] asset event insert failed for ${issueId}:`, evErr.message);
    }
  }

  return { ok: true, data: data as Record<string, unknown> };
}
