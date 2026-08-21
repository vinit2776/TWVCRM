import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createReminderEvent, rescheduleReminderEvent } from "@/lib/google-calendar";
import { istLocalToUtcIso } from "@/lib/utils";
import { autoUpdateLeadStatus } from "@/lib/auto-status";

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
  const { action, follow_up_date: rawFollowUpDate, note: rawNote } = body as {
    action: "close" | "reschedule" | "complete_tour";
    follow_up_date?: string;
    note?: string;
  };

  if (!action || !["close", "reschedule", "complete_tour"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (action === "reschedule" && !rawFollowUpDate) {
    return NextResponse.json(
      { error: "follow_up_date is required for reschedule" },
      { status: 400 }
    );
  }

  // Mark an existing "Tour" activity as completed in place — appends the
  // optional note to its description and backdates meeting_end_at so
  // autoUpdateLeadStatus advances the lead to tour_completed. Keeps the
  // outcome tied to the same activity record instead of logging a new one.
  if (action === "complete_tour") {
    const { data: existing, error: fetchError } = await supabase
      .from("activities")
      .select("type, lead_id, description")
      .eq("id", id)
      .single();

    if (fetchError || !existing) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }
    if (existing.type !== "tour") {
      return NextResponse.json(
        { error: "Only tour activities can be marked completed" },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    const description = note
      ? existing.description
        ? `${existing.description}\n\nTour completed: ${note}`
        : `Tour completed: ${note}`
      : existing.description;

    const { data, error } = await supabase
      .from("activities")
      .update({ meeting_end_at: now, description, updated_at: now })
      .eq("id", id)
      .select(
        "*, creator:users!activities_created_by_fkey(*), follow_up_actor:users!activities_follow_up_actioned_by_fkey(*)"
      )
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await autoUpdateLeadStatus(supabase, existing.lead_id, "tour", { meetingEndAt: now });

    return NextResponse.json({ data });
  }

  // toDatetimeLocalValue()/<input type="datetime-local"> send a naive
  // "yyyy-MM-ddTHH:mm" IST wall-clock string — same conversion needed here
  // as the create path, so a rescheduled time doesn't silently drift +5:30.
  const follow_up_date = rawFollowUpDate ? istLocalToUtcIso(rawFollowUpDate) : rawFollowUpDate;

  // Resolve auth user → internal users row for audit
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, email")
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
          // Reset so the WhatsApp cron sends a fresh nudge for the new time
          // instead of staying silent because the old time already fired.
          followup_wa_reminder_sent_at: null,
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

    const reminderParams = {
      activityId: data.id,
      leadId: data.lead_id,
      leadName,
      activityType: data.type,
      subject: data.subject,
      followUpDate: data.follow_up_date,
      followUpNotes: data.follow_up_notes,
      ownerEmail: dbUser.email,
    };

    if (data.calendar_event_id) {
      // An event already exists — patching it is idempotent, so two
      // concurrent reschedules racing here just apply the same update
      // twice. No claim needed.
      await rescheduleReminderEvent({ ...reminderParams, calendarEventId: data.calendar_event_id });
    } else {
      // No event yet. Atomically claim the "create" step with a
      // conditional update (NULL -> sentinel) so two concurrent
      // reschedules of a never-synced reminder can't both create a
      // duplicate calendar event — only the request that wins the claim
      // proceeds to call the Calendar API.
      const { data: claimedRow } = await supabase
        .from("activities")
        .update({ calendar_event_id: "pending" })
        .eq("id", data.id)
        .is("calendar_event_id", null)
        .select("id")
        .maybeSingle();

      if (claimedRow) {
        const calendarEventId = await createReminderEvent(reminderParams);
        // Writing null here (creation failed/skipped) releases the claim
        // so a future reschedule can retry instead of staying stuck.
        await supabase
          .from("activities")
          .update({ calendar_event_id: calendarEventId })
          .eq("id", data.id);
      }
    }
  }

  return NextResponse.json({ data });
}
