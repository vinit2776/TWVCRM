import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES, logIssueEvent, computeSlaTarget } from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import type { FacilityIssuePriority } from "@/types";

const VALID_PRIORITY: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];
const PRIORITY_RANK: Record<FacilityIssuePriority, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: issue, error } = await supabase
    .from("facility_issues")
    .select(`
      *,
      location:locations(id, name, code),
      floor:location_floors(id, name),
      space_unit:space_units(id, name, code),
      asset:facility_assets(id, name, asset_code),
      category:facility_asset_categories!facility_issues_category_id_fkey(*),
      reporter:users!facility_issues_reported_by_fkey(id, full_name, email),
      assignee:users!facility_issues_assigned_to_fkey(id, full_name, email),
      attachments:facility_issue_attachments(
        id, file_url, file_path, file_type, caption, phase, uploaded_at,
        uploader:users(id, full_name)
      ),
      events:facility_issue_events(
        id, event_type, actor_label, message, payload, created_at,
        actor:users(id, full_name)
      )
    `)
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.code === "PGRST116" ? 404 : 500 });
  }

  // Sort events ascending (timeline display)
  if (Array.isArray(issue.events)) {
    issue.events.sort((a: { created_at: string }, b: { created_at: string }) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }

  return NextResponse.json({ data: issue });
}

export async function PUT(
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

  // Load existing for diff
  const { data: existing, error: loadErr } = await supabase
    .from("facility_issues")
    .select("*, category:facility_asset_categories!facility_issues_category_id_fkey(default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs)")
    .eq("id", id)
    .single();
  if (loadErr || !existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};
  const allowed = [
    "title", "description", "priority", "category_id",
    "location_id", "floor_id", "space_unit_id", "asset_id",
    "reporter_name", "reporter_email", "reporter_phone",
    "parts_cost", "parts_notes",
    "resolution_notes", "resolution_root_cause",
  ];
  for (const f of allowed) if (f in body) updates[f] = body[f];

  if (updates.priority && !VALID_PRIORITY.includes(updates.priority as FacilityIssuePriority)) {
    return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
  }

  if ("title" in updates) {
    const trimmed = String(updates.title ?? "").trim();
    if (!trimmed) return NextResponse.json({ error: "Title can't be empty" }, { status: 400 });
    updates.title = trimmed;
  }

  // Manual TAT override — reported_problem only (delegated tasks track TAT via due_date).
  if ("tat_hours" in body && body.tat_hours != null && body.tat_hours !== "" && existing.task_type === "reported_problem") {
    const hours = Number(body.tat_hours);
    if (!isFinite(hours) || hours <= 0) {
      return NextResponse.json({ error: "tat_hours must be a positive number" }, { status: 400 });
    }
    updates.tat_hours = hours;
    updates.tat_manual_override = true;
    updates.sla_target_at = new Date(new Date(existing.reported_at).getTime() + hours * 3600 * 1000).toISOString();
    updates.sla_breached = false;
  } else if (
    // If priority changed, recompute SLA target from category defaults — unless
    // a manual TAT override is already in effect, which should survive a
    // priority change instead of being silently overwritten.
    updates.priority && updates.priority !== existing.priority && existing.category && !existing.tat_manual_override
  ) {
    updates.sla_target_at = computeSlaTarget(
      existing.category,
      updates.priority as FacilityIssuePriority,
      new Date(existing.reported_at)
    );
    updates.sla_breached = false;
  }

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Note title/description edits in timeline — otherwise these are silent:
  // logAudit below covers the admin-only audit trail, but this is the only
  // trace visible on the issue page itself (e.g. to the assignee).
  if (updates.title && updates.title !== existing.title) {
    await logIssueEvent(supabase, {
      issueId: id, eventType: "updated",
      actorId: dbUser!.id, actorLabel: dbUser!.full_name,
      message: `Title changed: "${existing.title}" → "${updates.title}"`,
      payload: { field: "title", from: existing.title, to: updates.title },
    });
  }
  if ("description" in updates && updates.description !== existing.description) {
    await logIssueEvent(supabase, {
      issueId: id, eventType: "updated",
      actorId: dbUser!.id, actorLabel: dbUser!.full_name,
      message: "Description updated",
      payload: { field: "description", from: existing.description, to: updates.description },
    });
  }

  // Note priority change in timeline
  if (updates.priority && updates.priority !== existing.priority) {
    await logIssueEvent(supabase, {
      issueId: id, eventType: "priority_changed",
      actorId: dbUser!.id, actorLabel: dbUser!.full_name,
      message: `Priority changed: ${existing.priority} → ${updates.priority}`,
      payload: { from: existing.priority, to: updates.priority },
    });

    // Only an escalation (severity increased) broadcasts across every channel —
    // a de-escalation isn't urgent enough to page the assignee.
    const isEscalation = PRIORITY_RANK[updates.priority as FacilityIssuePriority] > PRIORITY_RANK[existing.priority as FacilityIssuePriority];
    if (isEscalation) {
      await notifyIssueAssignee(
        { id, category_id: existing.category_id, assigned_to: existing.assigned_to, issue_number: existing.issue_number, title: existing.title },
        { type: "priority_escalated", from: existing.priority, to: updates.priority as string, actorName: dbUser!.full_name }
      );
    }
  }

  logAudit(supabase, {
    entityType: "facility_issue", entityId: id, action: "update",
    performedBy: dbUser!.id, changes: { record: { old: existing, new: data } },
  });

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  const { error } = await supabase.from("facility_issues").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: id, action: "delete", performedBy: dbUser!.id,
  });

  return NextResponse.json({ success: true });
}
