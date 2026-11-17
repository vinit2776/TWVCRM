import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { istLocalToUtcIso } from "@/lib/utils";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";
import { TOUR_OUTCOME_LABELS, tourOutcomeSubject } from "@/lib/tours";
import { datePart, timePart } from "@/lib/next-step-chip";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("outcome"),
    outcome: z.enum(["came", "no_show", "cancelled"]),
    note: z.string().trim().max(1000).optional(),
  }),
  // A naive "yyyy-MM-ddTHH:mm" IST wall-clock string, like every other date input here.
  z.object({ action: z.literal("reschedule"), meeting_start_at: z.string().min(16) }),
  z.object({ action: z.literal("set_host"), tour_host_id: z.string().uuid().nullable() }),
]);

const HOUR_MS = 60 * 60 * 1000;

// PATCH /api/tours/[id]
// Record what happened at a tour, move it, or change who hosts it. Recording an outcome closes the
// tour's own follow-up and writes a plain line on the lead's timeline; "came" moves the lead to
// Tour Completed. The next step (or closing the lead) is a separate call, so a tour is never left
// with an outcome and a lead is never silently left with nothing to do: the Leads list shows
// "No next step" until it is set. Nothing here contacts the customer.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admin, manager and sales roles can update a tour" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const { data: tour } = await supabase
    .from("activities")
    .select("id, type, lead_id, description, meeting_start_at, meeting_end_at, tour_outcome")
    .eq("id", id)
    .single();
  if (!tour || tour.type !== "tour") return NextResponse.json({ error: "Tour not found" }, { status: 404 });
  if (tour.tour_outcome && body.action !== "set_host") {
    return NextResponse.json({ error: "This tour already has an outcome" }, { status: 409 });
  }

  const now = new Date().toISOString();

  if (body.action === "set_host") {
    const { error } = await supabase.from("activities").update({ tour_host_id: body.tour_host_id, updated_at: now }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "reschedule") {
    const startIso = istLocalToUtcIso(body.meeting_start_at);
    if (Number.isNaN(Date.parse(startIso)) || Date.parse(startIso) <= Date.now()) {
      return NextResponse.json({ error: "Pick a time that has not passed" }, { status: 400 });
    }
    const endIso = new Date(Date.parse(startIso) + HOUR_MS).toISOString();
    const from = tour.meeting_start_at ? `${datePart(tour.meeting_start_at)}, ${timePart(tour.meeting_start_at)}` : "an earlier time";
    const { error } = await supabase
      .from("activities")
      .update({
        meeting_start_at: startIso,
        meeting_end_at: endIso,
        // The tour is the lead's next step, so it moves with it.
        follow_up_date: startIso,
        is_follow_up_done: false,
        // Let the reminder go out again for the new time.
        tour_reminder_sent_at: null,
        updated_at: now,
      })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase.from("activities").insert({
      lead_id: tour.lead_id,
      type: "note",
      subject: "Tour rescheduled",
      description: `From ${from} to ${datePart(startIso)}, ${timePart(startIso)}`,
      created_by: me.id,
    });
    logAudit(supabase, {
      entityType: "lead",
      entityId: tour.lead_id,
      action: "update",
      performedBy: me.id,
      changes: { tour_start: { old: tour.meeting_start_at, new: startIso } },
    });
    return NextResponse.json({ ok: true });
  }

  // outcome
  const label = TOUR_OUTCOME_LABELS[body.outcome];
  const note = body.note ?? "";
  const { error } = await supabase
    .from("activities")
    .update({
      tour_outcome: body.outcome,
      tour_outcome_at: now,
      tour_outcome_by: me.id,
      // The tour's own follow-up is dealt with by recording what happened.
      is_follow_up_done: true,
      follow_up_actioned_by: me.id,
      follow_up_actioned_at: now,
      description: note
        ? tour.description
          ? `${tour.description}\n\nTour ${label.toLowerCase()}: ${note}`
          : `Tour ${label.toLowerCase()}: ${note}`
        : tour.description,
      updated_at: now,
    })
    .eq("id", id)
    .is("tour_outcome", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("activities").insert({
    lead_id: tour.lead_id,
    type: "note",
    subject: tourOutcomeSubject(body.outcome),
    description: note || null,
    created_by: me.id,
  });

  // Only a tour that was held moves the lead on. A no-show or cancellation leaves it where it is.
  if (body.outcome === "came") await autoUpdateLeadStatus(supabase, tour.lead_id, "tour", { meetingEndAt: now });

  logAudit(supabase, {
    entityType: "lead",
    entityId: tour.lead_id,
    action: "update",
    performedBy: me.id,
    changes: { tour_outcome: { old: null, new: body.outcome } },
  });
  return NextResponse.json({ ok: true });
}
