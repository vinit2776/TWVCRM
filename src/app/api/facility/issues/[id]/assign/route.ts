import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { logIssueEvent } from "@/lib/facility";
import { notifyIssueAssignee } from "@/lib/facility-notifications";

const OVERRIDE_ROLES = ["admin", "manager", "office_admin"] as const;
type OverrideRole = typeof OVERRIDE_ROLES[number];
function isOverrideTier(role: string | undefined | null): role is OverrideRole {
  return OVERRIDE_ROLES.includes(role as OverrideRole);
}

/**
 * POST /api/facility/issues/[id]/assign
 *
 * Three paths:
 *  1. Claim (assignee_id = self, no current owner) — any authenticated user
 *  2. Assign-to-other (assignee_id != self or null) — override tier
 *     (admin/manager/office_admin) or the ticket's own reporter
 *  3. Take-over (take_over: true, current owner exists) — any authenticated user
 *
 * Body: { assignee_id?: string | null, take_over?: boolean }
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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const assigneeId: string | null = body.assignee_id ?? null;
  const takeOver: boolean = body.take_over === true;

  // Load current issue state
  const { data: prev, error: prevErr } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, status, category_id, assigned_to, reported_by, assignee:users!facility_issues_assigned_to_fkey(id, full_name)")
    .eq("id", id).single();
  if (prevErr || !prev) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const prevAssigneeId = prev.assigned_to as string | null;
  const prevAssigneeName = (prev.assignee as { full_name?: string } | null)?.full_name ?? null;

  const isSelf = assigneeId === dbUser.id;
  // A ticket's original reporter can always hand it to anyone, same as
  // override tier — they created it, so they're trusted to route it, even
  // once they're the current owner (e.g. self-took-over from someone else).
  const isReporter = !!prev.reported_by && prev.reported_by === dbUser.id;
  const override = isOverrideTier(dbUser.role) || isReporter;

  // ── Path 3: Take-over ────────────────────────────────────────────────────
  if (takeOver) {
    if (!prevAssigneeId) {
      return NextResponse.json({ error: "Ticket is not owned — use Claim instead" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("facility_issues")
      .update({ assigned_to: dbUser.id, assigned_at: now, assigned_by: dbUser.id })
      .eq("id", id).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logIssueEvent(supabase, {
      issueId: id, eventType: "assigned",
      actorId: dbUser.id, actorLabel: dbUser.full_name,
      message: `Taken over from ${prevAssigneeName ?? "previous owner"} by ${dbUser.full_name}`,
      payload: { from: prevAssigneeId, to: dbUser.id, take_over: true },
    });
    logAudit(supabase, {
      entityType: "facility_issue", entityId: id, action: "update",
      performedBy: dbUser.id,
      changes: { assigned_to: { old: prevAssigneeId, new: dbUser.id } },
    });
    // Notify the previous assignee via push only
    await notifyIssueAssignee(
      { id, category_id: prev.category_id, assigned_to: prevAssigneeId, issue_number: prev.issue_number, title: prev.title },
      { type: "taken_over", newOwnerName: dbUser.full_name }
    );
    return NextResponse.json({ data });
  }

  // ── Path 1: Claim (self, no existing owner) ──────────────────────────────
  if (isSelf && !prevAssigneeId) {
    const now = new Date().toISOString();
    // Race-safe: only succeeds if assigned_to is still NULL at write time
    const { data, error } = await supabase
      .from("facility_issues")
      .update({
        assigned_to: dbUser.id,
        assigned_at: now,
        assigned_by: dbUser.id,
        claimed_at: now,
        // Transition to acknowledged if still new/reopened
        ...((prev.status === "new" || prev.status === "reopened") ? {
          status: "acknowledged",
          acknowledged_at: now,
        } : {}),
      })
      .eq("id", id)
      .is("assigned_to", null)  // race guard
      .select().single();

    if (error || !data) {
      // Someone else claimed it in the last millisecond
      const { data: winner } = await supabase
        .from("facility_issues")
        .select("assignee:users!facility_issues_assigned_to_fkey(full_name)")
        .eq("id", id).single();
      const winnerName = (winner?.assignee as { full_name?: string } | null)?.full_name ?? "someone else";
      return NextResponse.json({ error: `This ticket was just claimed by ${winnerName}.` }, { status: 409 });
    }

    await logIssueEvent(supabase, {
      issueId: id, eventType: "claimed",
      actorId: dbUser.id, actorLabel: dbUser.full_name,
      message: `Claimed by ${dbUser.full_name}`,
      payload: { claimedBy: dbUser.id },
    });
    logAudit(supabase, {
      entityType: "facility_issue", entityId: id, action: "update",
      performedBy: dbUser.id,
      changes: { assigned_to: { old: null, new: dbUser.id }, status: { old: prev.status, new: "acknowledged" } },
    });
    await notifyIssueAssignee(
      { id, category_id: prev.category_id, assigned_to: dbUser.id, issue_number: prev.issue_number, title: prev.title },
      { type: "claimed", claimerName: dbUser.full_name }
    );
    return NextResponse.json({ data });
  }

  // ── Path 2: Assign-to-other (or unassign) — override tier only ───────────
  if (!override) {
    if (isSelf && prevAssigneeId) {
      // Self-assign when already owned: treat as take-over
      return NextResponse.json({ error: "Ticket already owned. Use take_over: true to take it over." }, { status: 400 });
    }
    return NextResponse.json({ error: "Only managers, admins, or this ticket's reporter can assign it to others" }, { status: 403 });
  }

  let assigneeName: string | null = null;
  if (assigneeId) {
    const { data: u } = await supabase
      .from("users").select("id, full_name, is_active").eq("id", assigneeId).single();
    if (!u) return NextResponse.json({ error: "Assignee not found" }, { status: 404 });
    if (u.is_active === false) return NextResponse.json({ error: "Assignee inactive" }, { status: 400 });
    assigneeName = u.full_name;
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    assigned_to: assigneeId,
    assigned_at: assigneeId ? now : null,
    assigned_by: dbUser.id,
  };
  if (assigneeId) {
    // Set claimed_at only if not already claimed
    if (!prevAssigneeId) {
      updates.claimed_at = now;
    }
    // Transition to acknowledged if still new/reopened
    if (prev.status === "new" || prev.status === "reopened") {
      updates.status = "acknowledged";
      updates.acknowledged_at = now;
    }
  }

  const { data, error } = await supabase
    .from("facility_issues").update(updates).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logIssueEvent(supabase, {
    issueId: id, eventType: "assigned",
    actorId: dbUser.id, actorLabel: dbUser.full_name,
    message: assigneeId
      ? `Assigned to ${assigneeName}${prevAssigneeId ? ` (was ${prevAssigneeName})` : ""}`
      : `Unassigned (was ${prevAssigneeName ?? "—"})`,
    payload: { from: prevAssigneeId, to: assigneeId },
  });
  logAudit(supabase, {
    entityType: "facility_issue", entityId: id, action: "update",
    performedBy: dbUser.id,
    changes: { assigned_to: { old: prevAssigneeId, new: assigneeId } },
  });
  await notifyIssueAssignee(
    { id, category_id: prev.category_id, assigned_to: assigneeId, issue_number: prev.issue_number, title: prev.title },
    { type: "assigned", assigneeName, actorName: dbUser.full_name }
  );

  return NextResponse.json({ data });
}
