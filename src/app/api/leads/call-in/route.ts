import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { WORKSPACE_TYPES } from "@/lib/constants";
import { describeCallInRequirement, callInLeadName } from "@/lib/call-in-requirement";
import { istLocalToUtcIso } from "@/lib/utils";

const bodySchema = z
  .object({
    location_ids: z.array(z.string().uuid()).min(1, "Pick at least one location"),
    workspace_types: z.array(z.enum(WORKSPACE_TYPES)).min(1, "Pick what they are looking for"),
    seats: z.number().int().min(1, "How many seats?"),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    quoted_per_seat: z.number().min(0).optional(),
    budget_per_seat: z.number().min(0).optional(),
    requests: z.string().trim().max(2000).optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().email("That email doesn't look right").optional().or(z.literal("")),
    name: z.string().trim().max(120).optional(),
    company: z.string().trim().max(160).optional(),
    follow_up_date: z.string().min(1, "When will you follow up?"),
    follow_up_notes: z.string().trim().min(1, "What needs to happen?"),
    /** The caller's number already belongs to this lead: log the call there instead of making a duplicate. */
    existing_lead_id: z.string().uuid().optional(),
    /** Keep this lead in front of the team until someone unpins it. */
    pin: z.boolean().optional(),
  })
  .refine((v) => !!v.phone?.trim() || !!v.email?.trim(), {
    message: "Add a phone number or an email",
    path: ["phone"],
  });

// POST /api/leads/call-in
// Logs a call that is happening now: what they want (locations, seat types, seats, price, requests),
// how to reach them, and the next step. Creates the lead (source Inbound call, handled by the caller
// who took the call) and writes the call into its history, or, when the number already belongs to a
// lead, writes the call onto that lead. Nothing is sent to the customer.
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  const { data: me } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Locations in the order the caller preferred them; the first becomes the lead's own location.
  const { data: locationRows } = await supabase.from("locations").select("id, name").in("id", b.location_ids);
  const nameById = new Map((locationRows ?? []).map((l) => [l.id as string, l.name as string]));
  const locationNames = b.location_ids.map((id) => nameById.get(id)).filter((n): n is string => !!n);
  if (locationNames.length === 0) {
    return NextResponse.json({ error: "Those locations were not found" }, { status: 400 });
  }

  let leadId = b.existing_lead_id ?? null;
  let created = false;

  if (leadId) {
    const { data: existing } = await supabase.from("leads").select("id").eq("id", leadId).single();
    if (!existing) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    if (b.pin) await supabase.from("leads").update({ pinned_at: new Date().toISOString(), pinned_by: me.id }).eq("id", leadId);
  } else {
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        ...callInLeadName({ name: b.name, phone: b.phone, email: b.email }),
        company: b.company || null,
        email: b.email || null,
        mobile: b.phone || null,
        source: "inbound_call",
        status: "contacted",
        rating: "none",
        score: 0,
        location_id: b.location_ids[0],
        workspace_type: b.workspace_types[0],
        seat_capacity: b.seats,
        budget_per_seat: b.budget_per_seat ?? null,
        created_by: me.id,
        assigned_to: me.id,
        ...(b.pin ? { pinned_at: new Date().toISOString(), pinned_by: me.id } : {}),
      })
      .select("id, first_name, last_name")
      .single();
    if (error || !lead) return NextResponse.json({ error: error?.message ?? "Could not create the lead" }, { status: 500 });
    leadId = lead.id;
    created = true;
    logAudit(supabase, {
      entityType: "lead",
      entityId: lead.id,
      action: "create",
      performedBy: me.id,
      changes: { record: { old: null, new: { ...lead, source: "inbound_call" } } },
    });
  }

  const { data: activity, error: activityError } = await supabase
    .from("activities")
    .insert({
      lead_id: leadId,
      type: "call",
      subject: "Inbound call",
      description: describeCallInRequirement({
        locations: locationNames,
        types: b.workspace_types,
        seats: b.seats,
        startDate: b.start_date,
        quotedPerSeat: b.quoted_per_seat,
        budgetPerSeat: b.budget_per_seat,
        requests: b.requests,
      }),
      call_outcome: "connected",
      follow_up_date: istLocalToUtcIso(b.follow_up_date),
      follow_up_notes: b.follow_up_notes,
      created_by: me.id,
    })
    .select("id")
    .single();

  // The lead exists even if its first call note did not save: tell the caller, do not hide it.
  if (activityError) {
    console.error("[call-in] activity insert failed", activityError.code, activityError.message);
    return NextResponse.json(
      { data: { lead_id: leadId, created, activity_id: null }, warning: "The lead was saved but the call note was not. Add it on the lead." },
      { status: 201 },
    );
  }

  // A call on an existing lead moves it on from New, as logging any activity does.
  if (!created && leadId) await autoUpdateLeadStatus(supabase, leadId, "activity");

  return NextResponse.json({ data: { lead_id: leadId, created, activity_id: activity.id } }, { status: 201 });
}
