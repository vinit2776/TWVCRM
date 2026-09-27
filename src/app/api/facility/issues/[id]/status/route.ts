import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  hasRole, FACILITY_ROLES, canTransition, timestampsForStatus,
  logIssueEvent, computeSlaTarget,
} from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import { resolveIssue } from "@/lib/facility-resolve";
import type { FacilityIssueStatus, FacilityIssuePriority } from "@/types";

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

  // Resolving is shared with the asset-event route — see src/lib/facility-resolve.ts.
  // Both go through the one helper so SLA, KPI, satisfaction and notifications
  // can't drift apart again (issue #759). The ownership and role gates above
  // still belong to this route; they are its policy, not resolution's.
  if (next === "resolved") {
    const result = await resolveIssue(supabase, {
      issueId: id,
      actor: { id: dbUser!.id, authId: user.id, fullName: dbUser!.full_name },
      resolutionNotes: body.resolution_notes != null ? String(body.resolution_notes) : null,
      rootCause: body.resolution_root_cause ?? null,
      partsCost: body.parts_cost ?? null,
      partsNotes: body.parts_notes ?? null,
      logAssetEvent: true,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ data: result.data });
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

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: next === "reopened" ? "reopened" : "status_changed",
    actorId: dbUser!.id,
    actorLabel: dbUser!.full_name,
    message: `Status: ${existing.status} → ${next}`,
    payload: { from: existing.status, to: next },
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

  return NextResponse.json({ data });
}
