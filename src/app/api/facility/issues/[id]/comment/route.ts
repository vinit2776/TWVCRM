import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logIssueEvent } from "@/lib/facility";
import { notifyItTeam } from "@/lib/facility-notifications";

/**
 * POST /api/facility/issues/[id]/comment
 * Body: { message: string }
 * Adds a free-text comment to the issue timeline. No role gating beyond auth.
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
    .from("users").select("id, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const message = String(body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const { data: issue } = await supabase
    .from("facility_issues")
    .select("issue_number, title, assigned_to")
    .eq("id", id).single();

  await logIssueEvent(supabase, {
    issueId: id, eventType: "comment",
    actorId: dbUser.id, actorLabel: dbUser.full_name, message,
  });

  await notifyItTeam({
    type: "comment",
    issueId: id,
    issueNumber: issue?.issue_number ?? "",
    title: issue?.title ?? "",
    actorName: dbUser.full_name,
    message,
    assigneeId: issue?.assigned_to ?? undefined,
  });

  return NextResponse.json({ success: true }, { status: 201 });
}
