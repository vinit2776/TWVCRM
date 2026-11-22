import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { istLocalToUtcIso } from "@/lib/utils";
import { PARK_REASON_LABELS, parkProblem, releaseProblem, type ParkReason } from "@/lib/space-parking";

const parkSchema = z.object({
  location_id: z.string().uuid().nullish(),
  other_area: z.string().trim().max(120).nullish(),
  workspace_type: z.string().trim().max(60).nullish(),
  seats_needed: z.number().int().nullish(),
  reason: z.string().max(40),
  note: z.string().trim().max(1000),
  look_again_on: z.string().nullish(),
});
const releaseSchema = z.object({
  next_step: z.string().trim().max(500),
  // A naive "yyyy-MM-ddTHH:mm" IST wall-clock string, like every other date input here.
  follow_up_date: z.string().min(10),
});

async function context(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return { error: NextResponse.json({ error: "Only admin, manager and sales roles can park an enquiry" }, { status: 403 }) } as const;
  }
  const admin = createAdminClient();
  const { data: flag } = await admin.from("app_settings").select("value").eq("key", "space_waiting_enabled").maybeSingle();
  if (flag?.value !== "true") return { error: NextResponse.json({ error: "Waiting for space is not switched on yet" }, { status: 409 }) } as const;
  const { data: lead } = await supabase.from("leads").select("id, status, archived_at, parked_at, first_name, last_name").eq("id", id).single();
  if (!lead) return { error: NextResponse.json({ error: "Lead not found" }, { status: 404 }) } as const;
  return { supabase, admin, me, lead } as const;
}

// POST /api/leads/[id]/park
// Park a real enquiry we cannot offer yet: where they want space, what and how many, why we cannot
// offer it, a note, and an optional look-again date (a reminder for staff only). It leaves the
// follow-up lists (its pending follow-ups are closed with a note), never goes stale, and waits in
// Waiting for space. Nothing is sent to the customer.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, me, lead } = ctx;

  const parsed = parkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  const problem = parkProblem({ locationId: b.location_id, otherArea: b.other_area, reason: b.reason, note: b.note, lookAgainOn: b.look_again_on, seatsNeeded: b.seats_needed });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (["won", "lost", "junk"].includes(lead.status) || lead.archived_at) return NextResponse.json({ error: "This lead is closed" }, { status: 409 });
  if (lead.parked_at) return NextResponse.json({ error: "This enquiry is already waiting for space" }, { status: 409 });

  const now = new Date().toISOString();
  const { data: row, error } = await admin
    .from("parked_enquiries")
    .insert({
      lead_id: id,
      location_id: b.location_id ?? null,
      other_area: b.location_id ? null : (b.other_area ?? null),
      workspace_type: b.workspace_type ?? null,
      seats_needed: b.seats_needed ?? null,
      reason: b.reason,
      note: b.note,
      look_again_on: b.look_again_on ?? null,
      parked_by: me.id,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "This enquiry is already waiting for space" }, { status: 409 });
    console.error("[park] insert failed", error.code, error.message);
    return NextResponse.json({ error: "Could not park it" }, { status: 500 });
  }
  await admin.from("leads").update({ parked_at: now }).eq("id", id);

  // It leaves Call today: whatever follow-ups were pending are dealt with by parking.
  await supabase
    .from("activities")
    .update({ is_follow_up_done: true, follow_up_actioned_by: me.id, follow_up_actioned_at: now, updated_at: now })
    .eq("lead_id", id)
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null);
  await supabase.from("activities").insert({
    lead_id: id,
    type: "note",
    subject: "Waiting for space",
    description: `${PARK_REASON_LABELS[b.reason as ParkReason]}. ${b.note}${b.look_again_on ? ` Look again on ${b.look_again_on}.` : ""}`,
    created_by: me.id,
  });
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { parked: { old: null, new: b.reason } } });
  return NextResponse.json({ data: { id: row.id } }, { status: 201 });
}

// DELETE /api/leads/[id]/park { next_step, follow_up_date }
// Take it out of Waiting once an offer is possible: it becomes a normal lead again with this next
// step, so it never comes back to nothing. Nothing is sent to the customer.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, me, lead } = ctx;
  if (!lead.parked_at) return NextResponse.json({ error: "This enquiry is not waiting for space" }, { status: 409 });

  const parsed = releaseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Say what the next step is and when" }, { status: 400 });
  const problem = releaseProblem({ nextStep: parsed.data.next_step, followUpDate: istLocalToUtcIso(parsed.data.follow_up_date) });
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const now = new Date().toISOString();
  // Compare-and-set: only a row still waiting is released, so two people cannot both do it.
  const { data: released } = await admin
    .from("parked_enquiries")
    .update({ state: "released", released_by: me.id, released_at: now })
    .eq("lead_id", id)
    .neq("state", "released")
    .select("id");
  if (!released || released.length === 0) return NextResponse.json({ error: "Someone already took it out" }, { status: 409 });
  await admin.from("leads").update({ parked_at: null }).eq("id", id);

  await supabase.from("activities").insert({
    lead_id: id,
    type: "call",
    subject: "Back from Waiting for space",
    description: "Space can be offered: taken out of Waiting for space.",
    follow_up_date: istLocalToUtcIso(parsed.data.follow_up_date),
    follow_up_notes: parsed.data.next_step,
    is_follow_up_done: false,
    created_by: me.id,
  });
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { parked: { old: "waiting", new: null } } });
  return NextResponse.json({ ok: true });
}
