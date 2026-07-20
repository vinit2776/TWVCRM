import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createActivitySchema } from "@/lib/validations";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";
import { createReminderEvent } from "@/lib/google-calendar";
import { istLocalToUtcIso } from "@/lib/utils";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(
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

  const { searchParams } = new URL(request.url);
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || "", 10) || DEFAULT_LIMIT));

  const { data, error, count } = await supabase
    .from("activities")
    .select("*, creator:users!activities_created_by_fkey(*), follow_up_actor:users!activities_follow_up_actioned_by_fkey(*)", { count: "exact" })
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data: data ?? [],
    has_more: offset + limit < (count ?? 0),
  });
}

export async function POST(
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
  const result = createActivitySchema.safeParse({ ...body, lead_id: id });

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // FollowUpDateTimeInput sends a naive "yyyy-MM-ddTHH:mm" IST wall-clock
  // string — convert to a real UTC instant before it hits the DB or the
  // Google Calendar event, both of which would otherwise treat it as UTC.
  if (result.data.follow_up_date) {
    result.data.follow_up_date = istLocalToUtcIso(result.data.follow_up_date);
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, email")
    .eq("auth_id", user.id)
    .single();

  const { data, error } = await supabase
    .from("activities")
    .insert({
      ...result.data,
      created_by: dbUser?.id,
    })
    .select("*, creator:users!activities_created_by_fkey(*)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Auto-claim the lead to whoever logged the activity.
  // Transfers ownership even if another user had previously claimed it.
  // Skips if the user already owns the lead or the lead is resolved.
  if (dbUser?.id) {
    const { data: oldLead } = await supabase
      .from("leads")
      .select("claimed_by, claimed_at, resolved_at, first_name, last_name, company")
      .eq("id", id)
      .single();

    const alreadyOwner = oldLead?.claimed_by === dbUser.id;
    const isResolved = oldLead?.resolved_at != null;

    if (!alreadyOwner && !isResolved) {
      const claimedAt = new Date().toISOString();
      const { error: claimError } = await supabase
        .from("leads")
        .update({ claimed_by: dbUser.id, claimed_at: claimedAt })
        .eq("id", id);

      if (claimError) {
        console.error("auto-claim failed", claimError.code, claimError.message);
      } else {
        logAudit(supabase, {
          entityType: "lead",
          entityId: id,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            claimed_by: { old: oldLead?.claimed_by ?? null, new: dbUser.id },
            claimed_at: { old: oldLead?.claimed_at ?? null, new: claimedAt },
          },
        });
      }
    }

    if (result.data.follow_up_date && dbUser.email) {
      const leadName =
        oldLead?.company ||
        [oldLead?.first_name, oldLead?.last_name].filter(Boolean).join(" ") ||
        "this lead";

      const calendarEventId = await createReminderEvent({
        activityId: data.id,
        leadId: id,
        leadName,
        activityType: result.data.type,
        subject: result.data.subject,
        followUpDate: result.data.follow_up_date,
        followUpNotes: result.data.follow_up_notes,
        ownerEmail: dbUser.email,
      });

      if (calendarEventId) {
        await supabase
          .from("activities")
          .update({ calendar_event_id: calendarEventId })
          .eq("id", data.id);
      }
    }
  }

  // Auto-advance lead status based on activity type:
  // - tour activities drive tour_scheduled / tour_completed
  // - all others drive new → contacted
  if (result.data.type === "tour") {
    await autoUpdateLeadStatus(supabase, id, "tour", {
      meetingEndAt: result.data.meeting_end_at ?? null,
    });
  } else {
    await autoUpdateLeadStatus(supabase, id, "activity");
  }

  return NextResponse.json({ data }, { status: 201 });
}
