import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasRole, FACILITY_ROLES, logIssueEvent } from "@/lib/facility";
import { notifyItTeam } from "@/lib/facility-notifications";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_issue_collaborators")
    .select("id, user_id, added_at, user:users!facility_issue_collaborators_user_id_fkey(id, full_name, email, role)")
    .eq("issue_id", id)
    .order("added_at");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

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
  const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids : [body.user_id].filter(Boolean);

  if (!userIds.length) {
    return NextResponse.json({ error: "user_id or user_ids required" }, { status: 400 });
  }

  const rows = userIds.map((uid) => ({
    issue_id: id,
    user_id: uid,
    added_by: dbUser!.id,
  }));

  const { data, error } = await supabase
    .from("facility_issue_collaborators")
    .upsert(rows, { onConflict: "issue_id,user_id" })
    .select("id, user_id, added_at, user:users!facility_issue_collaborators_user_id_fkey(id, full_name, email, role)");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: issue } = await supabase
    .from("facility_issues")
    .select("issue_number, title, assigned_to")
    .eq("id", id).single();

  const names = (data ?? []).map((d) => (d.user as unknown as { full_name: string })?.full_name).filter(Boolean);
  await logIssueEvent(supabase, {
    issueId: id,
    eventType: "assigned",
    actorId: dbUser!.id,
    actorLabel: dbUser!.full_name,
    message: `Added collaborator${names.length > 1 ? "s" : ""}: ${names.join(", ")}`,
    payload: { collaborators_added: userIds },
  });

  await notifyItTeam({
    type: "assigned",
    issueId: id,
    issueNumber: issue?.issue_number ?? "",
    title: issue?.title ?? "",
    assigneeName: names.join(", "),
    assigneeId: issue?.assigned_to ?? undefined,
    actorName: dbUser!.full_name,
  });

  return NextResponse.json({ data: data ?? [] }, { status: 201 });
}

export async function DELETE(
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
  const userId = body.user_id;
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const { error } = await supabase
    .from("facility_issue_collaborators")
    .delete()
    .eq("issue_id", id)
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: "assigned",
    actorId: dbUser!.id,
    actorLabel: dbUser!.full_name,
    message: `Removed collaborator`,
    payload: { collaborator_removed: userId },
  });

  return NextResponse.json({ success: true });
}
