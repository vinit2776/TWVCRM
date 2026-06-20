import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES, logIssueEvent } from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";

/**
 * POST /api/facility/issues/[id]/assign
 * Body: { assignee_id: string | null }
 * Passing null unassigns. Records the assignment in the timeline.
 */
export async function POST(
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
  const assigneeId = body.assignee_id ?? null;

  let assigneeName: string | null = null;
  if (assigneeId) {
    const { data: u } = await supabase
      .from("users").select("id, full_name, role, is_active").eq("id", assigneeId).single();
    if (!u) return NextResponse.json({ error: "Assignee not found" }, { status: 404 });
    if (u.is_active === false) return NextResponse.json({ error: "Assignee inactive" }, { status: 400 });
    assigneeName = u.full_name;
  }

  const { data: prev } = await supabase
    .from("facility_issues")
    .select("issue_number, title, category_id, assigned_to, assignee:users!facility_issues_assigned_to_fkey(id, full_name)")
    .eq("id", id).single();

  const updates: Record<string, unknown> = {
    assigned_to: assigneeId,
    assigned_at: assigneeId ? new Date().toISOString() : null,
    assigned_by: dbUser!.id,
  };

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const prevName = (prev?.assignee as { full_name?: string } | null)?.full_name ?? "—";
  await logIssueEvent(supabase, {
    issueId: id, eventType: "assigned",
    actorId: dbUser!.id, actorLabel: dbUser!.full_name,
    message: assigneeId
      ? `Assigned to ${assigneeName}${prev?.assigned_to ? ` (was ${prevName})` : ""}`
      : `Unassigned (was ${prevName})`,
    payload: { from: prev?.assigned_to ?? null, to: assigneeId },
  });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: id, action: "update",
    performedBy: dbUser!.id,
    changes: { assigned_to: { old: prev?.assigned_to ?? null, new: assigneeId } },
  });

  await notifyIssueAssignee(
    { id, category_id: prev?.category_id ?? null, assigned_to: assigneeId, issue_number: prev?.issue_number ?? "", title: prev?.title ?? "" },
    { type: "assigned", assigneeName, actorName: dbUser!.full_name }
  );

  return NextResponse.json({ data });
}
