import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { hasRole, FACILITY_ROLES, logIssueEvent } from "@/lib/facility";
import { sendIssueNudge } from "@/lib/facility-nudges";

/**
 * GET /api/facility/issues/[id]/nudge
 * Lists nudge history for a ticket, with push delivery/click status merged
 * in from push_delivery_log (matched on provider_ref = batch_id).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: nudges, error } = await supabase
    .from("facility_issue_nudges")
    .select("id, channel, status, sent_by, sent_at, opened_at, provider_ref, error_message, sender:users!facility_issue_nudges_sent_by_fkey(id, full_name)")
    .eq("issue_id", id)
    .order("sent_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pushBatchIds = (nudges ?? []).filter((n) => n.channel === "push" && n.provider_ref).map((n) => n.provider_ref as string);
  let pushStatusByBatch: Record<string, { status: string; delivered_at: string | null; clicked_at: string | null }> = {};
  if (pushBatchIds.length > 0) {
    const adminClient = createAdminClient();
    const { data: logs } = await adminClient
      .from("push_delivery_log")
      .select("batch_id, status, delivered_at, clicked_at")
      .in("batch_id", pushBatchIds);
    pushStatusByBatch = Object.fromEntries(
      (logs ?? []).map((l) => [l.batch_id, { status: l.status, delivered_at: l.delivered_at, clicked_at: l.clicked_at }])
    );
  }

  const enriched = (nudges ?? []).map((n) => {
    if (n.channel === "push" && n.provider_ref && pushStatusByBatch[n.provider_ref]) {
      const live = pushStatusByBatch[n.provider_ref];
      return { ...n, status: live.clicked_at ? "read" : live.status === "delivered" ? "delivered" : n.status, delivered_at: live.delivered_at, clicked_at: live.clicked_at };
    }
    return n;
  });

  return NextResponse.json({ data: enriched });
}

/**
 * POST /api/facility/issues/[id]/nudge
 * Sends a manual "ask for update" nudge to the ticket's current assignee
 * via push + WhatsApp + email. Restricted to override-tier roles and the
 * ticket's reporter/delegator — the people with a legitimate reason to
 * chase a status update.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: issue } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, status, priority, assigned_to, reported_by")
    .eq("id", id)
    .single();
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const canNudge = hasRole(dbUser.role, FACILITY_ROLES.override) || issue.reported_by === dbUser.id;
  if (!canNudge) {
    return NextResponse.json({ error: "Only the reporter/delegator or admin/manager/office_admin can nudge" }, { status: 403 });
  }

  if (!issue.assigned_to) {
    return NextResponse.json({ error: "Ticket has no assignee to nudge" }, { status: 400 });
  }

  const results = await sendIssueNudge({
    issue: { id: issue.id, issue_number: issue.issue_number, title: issue.title, status: issue.status, priority: issue.priority },
    targetUserId: issue.assigned_to,
    sentBy: { id: dbUser.id, full_name: dbUser.full_name },
  });

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: "nudge_sent",
    actorId: dbUser.id,
    actorLabel: dbUser.full_name,
    message: `Nudged assignee for a status update (${results.map((r) => r.channel).join(", ") || "no channels available"})`,
    payload: { channels: results.map((r) => ({ channel: r.channel, status: r.status })) },
  });

  return NextResponse.json({ data: results }, { status: 201 });
}
