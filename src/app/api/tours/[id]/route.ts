import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { istLocalToUtcIso } from "@/lib/utils";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";
import { TOUR_OUTCOME_LABELS, tourOutcomeSubject } from "@/lib/tours";
import { datePart, timePart } from "@/lib/next-step-chip";
import { canWorkTour } from "@/lib/tour-reports";
import { createNotification } from "@/lib/in-app-notifications";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("outcome"),
    outcome: z.enum(["came", "no_show", "cancelled"]),
    note: z.string().trim().max(1000).optional(),
  }),
  // A naive "yyyy-MM-ddTHH:mm" IST wall-clock string, like every other date input here.
  z.object({ action: z.literal("reschedule"), meeting_start_at: z.string().min(16) }),
  z.object({ action: z.literal("set_host"), tour_host_id: z.string().uuid().nullable() }),
  // A colleague tagged to join the customer on the visit.
  z.object({ action: z.literal("set_accompanier"), accompanier_id: z.string().uuid().nullable() }),
  // The host marks the customer as arrived.
  z.object({ action: z.literal("arrived") }),
]);

/** A floor incharge can only say the customer arrived or did not come; the rest stays with the handlers. */
const FLOOR_ACTIONS = ["arrived", "outcome"];

const HOUR_MS = 60 * 60 * 1000;

// PATCH /api/tours/[id]
// Record what happened at a tour, move it, change who hosts or accompanies it, or mark the customer
// as arrived. A floor incharge may mark arrival or a no-show on tours at their own centre. Recording an outcome closes the
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
  if (!me || !([...LEAD_HANDLER_ROLES, "floor_manager"] as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admin, manager, sales and floor roles can update a tour" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const { data: tour } = await supabase
    .from("activities")
    .select("id, type, lead_id, description, meeting_start_at, meeting_end_at, tour_outcome, tour_host_id, accompanier_id, created_by, arrived_at, lead:leads!activities_lead_id_fkey(first_name, last_name, assigned_to, location_id)")
    .eq("id", id)
    .single();
  if (!tour || tour.type !== "tour") return NextResponse.json({ error: "Tour not found" }, { status: 404 });

  const lead = (tour as unknown as { lead: { assigned_to: string | null; location_id: string | null } | null }).lead;
  let inchargeIds: string[] = [];
  if (me.role === "floor_manager" && lead?.location_id) {
    const { data: loc } = await createAdminClient().from("locations").select("incharge_user_id_1, incharge_user_id_2").eq("id", lead.location_id).maybeSingle();
    inchargeIds = [loc?.incharge_user_id_1, loc?.incharge_user_id_2].filter((x): x is string => !!x);
  }
  const people = { hostId: tour.tour_host_id, accompanierId: tour.accompanier_id, createdBy: tour.created_by, leadOwnerId: lead?.assigned_to ?? null, inchargeIds };
  if (!canWorkTour(me.role, me.id, people)) return NextResponse.json({ error: "This tour is not at your centre" }, { status: 403 });
  if (me.role === "floor_manager" && (!FLOOR_ACTIONS.includes(body.action) || (body.action === "outcome" && body.outcome !== "no_show"))) {
    return NextResponse.json({ error: "A floor incharge can mark a customer arrived or a no-show" }, { status: 403 });
  }
  if (tour.tour_outcome && body.action !== "set_host") {
    return NextResponse.json({ error: "This tour already has an outcome" }, { status: 409 });
  }

  const now = new Date().toISOString();

  if (body.action === "arrived") {
    // Compare-and-set: the first press wins and a later one changes nothing.
    const { data: marked, error } = await supabase.from("activities").update({ arrived_at: now, updated_at: now }).eq("id", id).is("arrived_at", null).select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (marked && marked.length > 0) {
      logAudit(supabase, { entityType: "lead", entityId: tour.lead_id, action: "update", performedBy: me.id, changes: { tour_arrived_at: { old: null, new: now } } });
      // The person who booked it and the one accompanying hear that the customer is here.
      for (const uid of new Set([tour.created_by, tour.accompanier_id].filter((x): x is string => !!x && x !== me.id))) {
        await createNotification({ userId: uid, type: "tour_arrived", title: "Customer has arrived for the tour", body: "The host has marked the customer as arrived.", url: `/leads/${tour.lead_id}`, entityType: "lead", entityId: tour.lead_id }).catch(() => {});
      }
    }
    return NextResponse.json({ ok: true, already: !(marked && marked.length > 0) });
  }

  if (body.action === "set_accompanier") {
    const { error } = await supabase.from("activities").update({ accompanier_id: body.accompanier_id, updated_at: now }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (body.accompanier_id && body.accompanier_id !== me.id) {
      await createNotification({ userId: body.accompanier_id, type: "tour_accompany", title: "You are tagged to accompany a tour", body: "Open the lead for when and where.", url: `/leads/${tour.lead_id}`, entityType: "lead", entityId: tour.lead_id }).catch(() => {});
    }
    logAudit(supabase, { entityType: "lead", entityId: tour.lead_id, action: "update", performedBy: me.id, changes: { tour_accompanier: { old: tour.accompanier_id, new: body.accompanier_id } } });
    return NextResponse.json({ ok: true });
  }

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

  // A customer who did not come: the person who booked the tour gets a "Re-book or close" job.
  if (body.outcome === "no_show" && tour.created_by && tour.created_by !== me.id) {
    const admin = createAdminClient();
    const { data: flag } = await admin.from("app_settings").select("value").eq("key", "handover_jobs_enabled").maybeSingle();
    if (flag?.value === "true") {
      const l = lead as { first_name?: string; last_name?: string | null } | null;
      const leadName = `${l?.first_name ?? ""} ${l?.last_name === "-" ? "" : (l?.last_name ?? "")}`.trim() || "the customer";
      await admin.from("tasks").insert({
        title: `Re-book or close: ${leadName}`,
        description: note || null,
        status: "todo",
        priority: "medium",
        lead_id: tour.lead_id,
        assigned_to: tour.created_by,
        tags: [] as string[],
        kind: "other",
        brief: { discussed: "The customer did not come to the tour. Re-book it, or close the lead.", proposal_kind: null },
        created_by: me.id,
        handed_over_by: me.id,
      });
    }
    await createNotification({ userId: tour.created_by, type: "tour_no_show", title: "Customer did not come to the tour", body: "Re-book it or close the lead.", url: `/leads/${tour.lead_id}`, entityType: "lead", entityId: tour.lead_id }).catch(() => {});
  }

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
