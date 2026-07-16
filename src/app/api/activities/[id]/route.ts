import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendFollowUpReminderEmail } from "@/lib/reminder-email";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { action, follow_up_date } = body as {
    action: "close" | "reschedule";
    follow_up_date?: string;
  };

  if (!action || !["close", "reschedule"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (action === "reschedule" && !follow_up_date) {
    return NextResponse.json(
      { error: "follow_up_date is required for reschedule" },
      { status: 400 }
    );
  }

  // Resolve auth user → internal users row for audit
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, email, full_name")
    .eq("auth_id", user.id)
    .single();

  const now = new Date().toISOString();

  const updatePayload =
    action === "close"
      ? {
          is_follow_up_done: true,
          follow_up_actioned_by: dbUser?.id ?? null,
          follow_up_actioned_at: now,
          updated_at: now,
        }
      : {
          follow_up_date,
          is_follow_up_done: false,
          follow_up_actioned_by: dbUser?.id ?? null,
          follow_up_actioned_at: now,
          updated_at: now,
        };

  const { data, error } = await supabase
    .from("activities")
    .update(updatePayload)
    .eq("id", id)
    .select(
      "*, creator:users!activities_created_by_fkey(*), follow_up_actor:users!activities_follow_up_actioned_by_fkey(*)"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (action === "reschedule" && dbUser?.email && data.follow_up_date) {
    const { data: lead } = await supabase
      .from("leads")
      .select("first_name, last_name, company")
      .eq("id", data.lead_id)
      .single();

    const leadName =
      lead?.company ||
      [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") ||
      "this lead";

    sendFollowUpReminderEmail({
      activityId: data.id,
      leadId: data.lead_id,
      leadName,
      activityType: data.type,
      subject: data.subject,
      followUpDate: data.follow_up_date,
      followUpNotes: data.follow_up_notes,
      recipientEmail: dbUser.email,
      recipientName: dbUser.full_name ?? "there",
    });
  }

  return NextResponse.json({ data });
}
