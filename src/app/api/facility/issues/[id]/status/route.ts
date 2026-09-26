import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  hasRole, FACILITY_ROLES, canTransition, timestampsForStatus,
  resolutionMinutes, metSla, logIssueEvent, computeSlaTarget,
} from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import { computeKpiPoints, writeKpiCredits } from "@/lib/facility-kpi";
import type { FacilityIssueStatus, FacilityIssuePriority, FacilityRootCause } from "@/types";

const VALID_ROOT: FacilityRootCause[] = [
  "hardware_failure", "config_issue", "isp_outage", "power_issue",
  "user_error", "scheduled_maintenance", "wear_and_tear",
  "environmental", "unknown", "other",
];

/**
 * PATCH /api/facility/issues/[id]/status
 * Body: { status: <next>, resolution_notes?, resolution_root_cause?, parts_cost?, parts_notes? }
 * Validates the transition, sets timestamps, computes resolution_minutes,
 * compares to SLA target, writes timeline event, returns updated issue.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const body = await request.json();
  const next = body.status as FacilityIssueStatus;
  if (!next) return NextResponse.json({ error: "status is required" }, { status: 400 });

  const { data: existing, error: loadErr } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, status, priority, category_id, asset_id, assigned_to, reported_by, scope, acknowledged_at, started_at, resolved_at, closed_at, sla_target_at, sla_breached, reopen_count, reporter_email, reporter_phone, satisfaction_token, assignee:users!facility_issues_assigned_to_fkey(full_name)")
    .eq("id", id).single();
  if (loadErr || !existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Ownership gate: once a ticket is acknowledged, only the assignee or override tier can move it
  const isOverrideTier = ["admin", "manager", "office_admin"].includes(dbUser?.role ?? "");
  const isOwner = existing.assigned_to === dbUser?.id;
  const needsOwnershipCheck = !["new", "reopened"].includes(existing.status as string);
  if (needsOwnershipCheck && !isOwner && !isOverrideTier) {
    const ownerName = (existing.assignee as { full_name?: string } | null)?.full_name ?? "the assignee";
    return NextResponse.json(
      { error: `This ticket is assigned to ${ownerName}. Only they can update its status.` },
      { status: 403 }
    );
  }

  if (!canTransition(existing.status as FacilityIssueStatus, next)) {
    return NextResponse.json(
      { error: `Cannot transition from ${existing.status} to ${next}` },
      { status: 400 }
    );
  }

  const tsUpdates = timestampsForStatus(next, existing);
  const updates: Record<string, unknown> = { status: next, ...tsUpdates };

  // Reopen bookkeeping: increment counter and reset SLA so the cron can re-trigger
  if (next === "reopened") {
    updates.reopen_count = (existing.reopen_count ?? 0) + 1;
    updates.sla_breached = false;
    if (existing.category_id) {
      const { data: cat } = await supabase
        .from("facility_asset_categories")
        .select("default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs")
        .eq("id", existing.category_id)
        .single();
      if (cat) {
        updates.sla_target_at = computeSlaTarget(cat, existing.priority as FacilityIssuePriority);
      }
    }
  }

  // Resolution-related fields
  if (next === "resolved") {
    if (body.resolution_notes != null) updates.resolution_notes = String(body.resolution_notes);
    if (body.resolution_root_cause && VALID_ROOT.includes(body.resolution_root_cause)) {
      updates.resolution_root_cause = body.resolution_root_cause;
    }
    if (body.parts_cost != null) updates.parts_cost = Number(body.parts_cost) || 0;
    if (body.parts_notes != null) updates.parts_notes = String(body.parts_notes);

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
      .eq("issue_id", id);
    const kpiResult = computeKpiPoints({
      priority: existing.priority as FacilityIssuePriority,
      slaBreached: (updates.sla_breached ?? existing.sla_breached ?? false) as boolean,
      reopenCount: existing.reopen_count ?? 0,
      satisfactionRating: null,
      extensionExemptFlags: (exts ?? []).map((e) => e.kpi_exempt),
    });
    updates.kpi_points = kpiResult.total;
    updates.kpi_breakdown = kpiResult.lines;
  }

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (next === "resolved" && updates.kpi_points != null) {
    await writeKpiCredits(supabase, {
      issueId: id,
      scope: existing.scope as string,
      assignedTo: existing.assigned_to,
      total: updates.kpi_points as number,
    });
  }

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: next === "reopened" ? "reopened" : (next === "resolved" ? "resolved" : "status_changed"),
    actorId: dbUser!.id,
    actorLabel: dbUser!.full_name,
    message: `Status: ${existing.status} → ${next}`,
    payload: { from: existing.status, to: next, ...(updates.resolution_root_cause ? { root_cause: updates.resolution_root_cause } : {}) },
  });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: id, action: "update",
    performedBy: dbUser!.id, changes: { status: { old: existing.status, new: next } },
  });

  await notifyIssueAssignee(
    { id, category_id: existing.category_id, assigned_to: existing.assigned_to, issue_number: existing.issue_number, title: existing.title },
    {
      type: "status_changed", from: existing.status, to: next, actorName: dbUser!.full_name,
      reporterEmail: existing.reporter_email ?? null, satisfactionToken: existing.satisfaction_token ?? null,
      reportedByUserId: existing.reported_by ?? null,
    }
  );

  // Auto-log maintenance event on the linked asset when issue is resolved
  if (next === "resolved" && existing.asset_id) {
    await supabase.from("facility_asset_events").insert({
      asset_id: existing.asset_id,
      event_type: "maintenance",
      note: `Resolved via ${existing.issue_number}: ${existing.title}`,
      logged_by: dbUser!.id,
      issue_id: id,
    });
  }

  return NextResponse.json({ data });
}
