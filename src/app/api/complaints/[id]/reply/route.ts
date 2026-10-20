import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { MAX_REPLY_CHARS, sendComplaintReply } from "@/lib/complaint-messages";
import { effectiveComplaintStatus, isOpenComplaint, type ComplaintStatus } from "@/lib/complaints";

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_REPLY_CHARS * 2) });

// POST /api/complaints/[id]/reply  { text }
// Sends the customer a short update about their complaint (the approved "update" template with
// the text as its message), while the complaint is open. Records it whether or not it was sent.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Write the message to send" }, { status: 400 });

  const admin = await createAdminClient();
  const { data: c } = await admin
    .from("customer_complaints")
    .select("status, issue:facility_issues!customer_complaints_issue_id_fkey(status), task:tasks!customer_complaints_task_id_fkey(status)")
    .eq("id", id)
    .single();
  if (!c) return NextResponse.json({ error: "Complaint not found" }, { status: 404 });
  // A complaint closes when its work order is resolved, so judge it by the derived status.
  const effective = effectiveComplaintStatus(c.status as ComplaintStatus, (c.issue as unknown as { status: string } | null)?.status ?? null, (c.task as unknown as { status: string } | null)?.status ?? null);
  if (!isOpenComplaint(effective)) {
    return NextResponse.json({ error: "This complaint is closed" }, { status: 409 });
  }

  const outcome = await sendComplaintReply(admin, { complaintId: id, kind: "update", text: parsed.data.text, sentBy: dbUser.id });
  if (outcome.status === "sent") return NextResponse.json({ success: true });
  if (outcome.status === "skipped" && outcome.detail === "template not configured") {
    return NextResponse.json({ error: "The update template isn't approved yet, so nothing was sent. Reply from WhatsApp instead." }, { status: 409 });
  }
  return NextResponse.json({ error: `Couldn't send: ${outcome.detail ?? outcome.status}` }, { status: 502 });
}
