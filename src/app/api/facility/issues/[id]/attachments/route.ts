import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logIssueEvent } from "@/lib/facility";
import type { FacilityAttachmentPhase } from "@/types";

const VALID_PHASE: FacilityAttachmentPhase[] = ["report", "progress", "resolution"];

/**
 * POST /api/facility/issues/[id]/attachments
 * Body: { file_url, file_path, file_type?, caption?, phase? }
 * Caller is expected to have already uploaded the file to the
 * `facility-issue-photos` storage bucket and pass the resulting URL + path.
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
  const { file_url, file_path, file_type = "image", caption, phase = "report" } = body;
  if (!file_url || !file_path) {
    return NextResponse.json({ error: "file_url and file_path are required" }, { status: 400 });
  }
  if (!VALID_PHASE.includes(phase as FacilityAttachmentPhase)) {
    return NextResponse.json({ error: "Invalid phase" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("facility_issue_attachments")
    .insert({
      issue_id: id, file_url, file_path,
      file_type, caption: caption || null,
      phase, uploaded_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logIssueEvent(supabase, {
    issueId: id, eventType: "photo_added",
    actorId: dbUser.id, actorLabel: dbUser.full_name,
    message: `Attachment added (${phase})`,
    payload: { attachment_id: data.id, file_type, phase },
  });

  return NextResponse.json({ data }, { status: 201 });
}

/**
 * DELETE /api/facility/issues/[id]/attachments?attachment_id=...
 * Removes the DB row only — Supabase storage cleanup happens via a
 * separate cron / lifecycle policy if needed.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const attachmentId = searchParams.get("attachment_id");
  if (!attachmentId) return NextResponse.json({ error: "attachment_id is required" }, { status: 400 });

  const { error } = await supabase
    .from("facility_issue_attachments")
    .delete().eq("id", attachmentId).eq("issue_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
