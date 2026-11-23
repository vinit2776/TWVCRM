import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createActivitySchema } from "@/lib/validations";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";
import { createReminderEvent } from "@/lib/google-calendar";
import { istLocalToUtcIso } from "@/lib/utils";
import { followUpClosedRows } from "@/lib/follow-up-closed-note";
import { completeHandoverJobsForActivity } from "@/lib/handover-finish-server";
import { syncTourCalendar } from "@/lib/tour-calendar-server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";

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

  // FollowUpDateTimeInput and <input type="datetime-local"> both send a naive
  // "yyyy-MM-ddTHH:mm" IST wall-clock string — convert to a real UTC instant
  // before it hits the DB (or the Google Calendar event for follow_up_date),
  // both of which would otherwise treat it as UTC.
  if (result.data.follow_up_date) {
    result.data.follow_up_date = istLocalToUtcIso(result.data.follow_up_date);
  }
  if (result.data.meeting_start_at) {
    result.data.meeting_start_at = istLocalToUtcIso(result.data.meeting_start_at);
  }
  if (result.data.meeting_end_at) {
    result.data.meeting_end_at = istLocalToUtcIso(result.data.meeting_end_at);
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, email")
    .eq("auth_id", user.id)
    .single();

  const { closes_open_follow_ups, ...activityFields } = result.data;

  const { data, error } = await supabase
    .from("activities")
    .insert({
      ...activityFields,
      created_by: dbUser?.id,
    })
    .select("*, creator:users!activities_created_by_fkey(*)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // A tour with a host goes on the host's calendar (and the accompanier's, once tagged).
  if (result.data.type === "tour") await syncTourCalendar(await createAdminClient(), data.id);

  // A call or tour logged by the person a hand-over job was given to finishes that job.
  if (dbUser?.id) {
    await completeHandoverJobsForActivity(await createAdminClient(), {
      leadId: id,
      userId: dbUser.id,
      activityType: result.data.type,
      callOutcome: result.data.call_outcome,
      activityCreatedAt: data.created_at,
    }).catch((e) => console.error("[handover] finish failed:", e));
  }

  // A contact logged from the list or the lead page deals with what was already pending: close the
  // older open follow-ups so the lead doesn't keep showing "overdue" for something just handled.
  if (closes_open_follow_ups) {
    const now = new Date().toISOString();
    // What is overdue or due today is always handled by this contact. When it also sets a new next
    // step, that replaces the older ones too, so the lead has one next step and not two; a tour
    // booked for a later day is the exception, because the call doesn't change it.
    const istToday = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const endOfToday = `${istToday}T23:59:59.999+05:30`;
    const open = supabase
      .from("activities")
      .update({
        is_follow_up_done: true,
        follow_up_actioned_by: dbUser?.id ?? null,
        follow_up_actioned_at: now,
        updated_at: now,
      })
      .eq("lead_id", id)
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null)
      .neq("id", data.id);
    const { data: closed, error: closeError } = await (result.data.follow_up_date
      ? open.or(`follow_up_date.lte.${endOfToday},type.neq.tour`)
      : open.lte("follow_up_date", endOfToday)
    ).select("id, follow_up_date, follow_up_notes, subject");

    if (closeError) {
      console.error("closing earlier follow-ups failed", closeError.code, closeError.message);
    } else if (closed && closed.length > 0) {
      const { error: noteError } = await supabase.from("activities").insert(
        followUpClosedRows({
          leadId: id,
          closed,
          createdBy: dbUser?.id,
          replacedBy: result.data.subject || "this contact",
        })
      );
      if (noteError) console.error("follow-up closed note failed", noteError.code, noteError.message);
    }
    if (!closeError && closed && closed.length > 0 && dbUser?.id) {
      logAudit(supabase, {
        entityType: "lead",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: { follow_ups_closed_by_contact: { old: closed.length, new: data.id } },
      });
    }
  }

  // Auto-claim: whoever logs an activity takes over every OPEN enquiry on this lead.
  // Transfers ownership even if another user had claimed it; resolved enquiries are left
  // alone, and nothing happens for a lead that never came through a public form.
  if (dbUser?.id) {
    const admin = await createAdminClient();
    const { data: openEnquiries } = await admin
      .from("lead_enquiries")
      .select("id, reference, claimed_by, claimed_at")
      .eq("lead_id", id)
      .is("resolved_at", null)
      .or(`claimed_by.is.null,claimed_by.neq.${dbUser.id}`);

    if (openEnquiries && openEnquiries.length > 0) {
      const claimedAt = new Date().toISOString();
      const { error: claimError } = await admin
        .from("lead_enquiries")
        .update({ claimed_by: dbUser.id, claimed_at: claimedAt })
        .in("id", openEnquiries.map((e) => e.id));

      if (claimError) {
        console.error("auto-claim failed", claimError.code, claimError.message);
      } else {
        logAudit(supabase, {
          entityType: "lead",
          entityId: id,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            enquiries_claimed: {
              old: openEnquiries.map((e) => e.reference).join(", "),
              new: dbUser.id,
            },
            claimed_at: { old: openEnquiries[0].claimed_at ?? null, new: claimedAt },
          },
        });
      }
    }

    const { data: oldLead } = await supabase
      .from("leads")
      .select("first_name, last_name, company, assigned_to, archived_at")
      .eq("id", id)
      .single();

    // The person who works an enquiry owns the lead. Without this, a lead that someone has called
    // still reads "Unassigned" and belongs to nobody if they go on leave. Only for a real contact
    // (not a bare note), only when nobody handles it yet, and only for roles that can handle leads.
    const { data: me } = await supabase.from("users").select("role, full_name").eq("id", dbUser.id).single();
    if (
      result.data.type !== "note" &&
      oldLead &&
      !oldLead.assigned_to &&
      !oldLead.archived_at &&
      me &&
      (LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)
    ) {
      const { count: openCount } = await admin
        .from("lead_enquiries")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", id)
        .is("resolved_at", null);
      if ((openCount ?? 0) > 0) {
        // Compare-and-set: if someone claimed it a moment ago, leave theirs.
        const { data: taken } = await admin
          .from("leads")
          .update({ assigned_to: dbUser.id })
          .eq("id", id)
          .is("assigned_to", null)
          .select("id")
          .maybeSingle();
        if (taken) {
          const { error: claimNoteError } = await supabase.from("activities").insert({
            lead_id: id,
            type: "note",
            subject: "Claimed",
            description: `${me.full_name} took this lead`,
            created_by: dbUser.id,
          });
          if (claimNoteError) console.error("[activities] claim note failed", claimNoteError.code, claimNoteError.message);
          logAudit(supabase, {
            entityType: "lead",
            entityId: id,
            action: "update",
            performedBy: dbUser.id,
            changes: { assigned_to: { old: null, new: dbUser.id } },
          });
        }
      }
    }

    // One next step, whichever screen it was set on: a follow-up set on the lead also becomes the
    // open enquiry's "Next:" line, so the enquiry card never says something the lead doesn't.
    if (result.data.follow_up_date && result.data.type !== "tour") {
      const day = new Date(new Date(result.data.follow_up_date).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
      const stepText = (result.data.follow_up_notes || result.data.subject || "Follow up").slice(0, 500);
      const { error: mirrorError } = await admin
        .from("lead_enquiries")
        .update({
          next_step: stepText,
          follow_up_at: `${day}T00:00:00+05:30`,
          next_step_by: dbUser.id,
          next_step_at: new Date().toISOString(),
        })
        .eq("lead_id", id)
        .is("resolved_at", null);
      if (mirrorError) console.error("[activities] enquiry next step mirror failed", mirrorError.code, mirrorError.message);
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
