import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  hasRole, FACILITY_ROLES, canTransition, timestampsForStatus,
  resolutionMinutes, metSla, logIssueEvent,
} from "@/lib/facility";
import { notifyItTeam } from "@/lib/facility-notifications";
import type { FacilityIssueStatus, FacilityRootCause } from "@/types";

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
    .select("id, issue_number, title, status, assigned_to, acknowledged_at, started_at, resolved_at, closed_at, sla_target_at, reopen_count, reporter_email, reporter_phone")
    .eq("id", id).single();
  if (loadErr || !existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!canTransition(existing.status as FacilityIssueStatus, next)) {
    return NextResponse.json(
      { error: `Cannot transition from ${existing.status} to ${next}` },
      { status: 400 }
    );
  }

  const tsUpdates = timestampsForStatus(next, existing);
  const updates: Record<string, unknown> = { status: next, ...tsUpdates };

  // Reopen bookkeeping
  if (next === "reopened") {
    updates.reopen_count = (existing.reopen_count ?? 0) + 1;
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
  }

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  await notifyItTeam({
    type: "status_changed",
    issueId: id,
    issueNumber: existing.issue_number,
    title: existing.title,
    from: existing.status,
    to: next,
    actorName: dbUser!.full_name,
    assigneeId: existing.assigned_to ?? undefined,
  });

  return NextResponse.json({ data });
}
