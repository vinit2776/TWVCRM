import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logIssueEvent } from "@/lib/facility";
import { notifyIssueAssignee, notifyMentionedUsers } from "@/lib/facility-notifications";

/**
 * POST /api/facility/issues/[id]/comment
 * Body: { message: string, mentionedUserIds?: string[] }
 * Adds a free-text comment to the issue timeline. No role gating beyond auth.
 * mentionedUserIds are re-validated here (active users, not self) rather than
 * trusted from the client — they drive who gets a "you were mentioned" ping.
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

  const requestedMentionIds = Array.isArray(body.mentionedUserIds)
    ? body.mentionedUserIds.filter((v: unknown): v is string => typeof v === "string" && v !== dbUser.id)
    : [];

  let mentionedUserIds: string[] = [];
  if (requestedMentionIds.length > 0) {
    const { data: mentionedUsers } = await supabase
      .from("users")
      .select("id")
      .in("id", requestedMentionIds)
      .eq("is_active", true);
    mentionedUserIds = (mentionedUsers ?? []).map((u) => u.id as string);
  }

  const { data: issue } = await supabase
    .from("facility_issues")
    .select("issue_number, title, category_id, assigned_to")
    .eq("id", id).single();

  await logIssueEvent(supabase, {
    issueId: id, eventType: "comment",
    actorId: dbUser.id, actorLabel: dbUser.full_name, message,
    payload: mentionedUserIds.length > 0 ? { mentioned_user_ids: mentionedUserIds } : {},
  });

  const issueRef = { id, category_id: issue?.category_id ?? null, assigned_to: issue?.assigned_to ?? null, issue_number: issue?.issue_number ?? "", title: issue?.title ?? "" };

  const alreadyNotified = await notifyIssueAssignee(issueRef, { type: "comment", actorName: dbUser.full_name, message });

  const extraMentions = mentionedUserIds.filter((uid) => !alreadyNotified.includes(uid));
  if (extraMentions.length > 0) {
    await notifyMentionedUsers(issueRef, { actorName: dbUser.full_name, message, userIds: extraMentions });
  }

  return NextResponse.json({ success: true }, { status: 201 });
}
