import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { NUMBER_LABELS, last10Of } from "@/lib/whatsapp-gate";

const postSchema = z.object({
  label: z.enum(NUMBER_LABELS),
  name: z.string().trim().max(80).optional(),
});

const undoSchema = z.object({
  stashed_ids: z.array(z.string().uuid()).max(200),
  /** The label the number had before this call, or null if it had none. */
  previous: z.object({ label: z.enum(NUMBER_LABELS), name: z.string().nullable() }).nullable(),
  lead_junked: z.boolean(),
});

/** Who is calling, which enquiry this is, and the number behind it. */
async function load(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 403 }) };
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };

  const admin = await createAdminClient();
  const { data: enquiry } = await admin
    .from("lead_enquiries")
    .select("id, source, lead_id, payload, lead:leads(mobile, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!enquiry) return { error: NextResponse.json({ error: "Enquiry not found" }, { status: 404 }) };
  if (enquiry.source !== "whatsapp") {
    return { error: NextResponse.json({ error: "Only WhatsApp enquiries can be labelled by number" }, { status: 409 }) };
  }

  const lead = (Array.isArray(enquiry.lead) ? enquiry.lead[0] : enquiry.lead) as { mobile: string | null; phone: string | null } | null;
  const rawNumber = (enquiry.payload as { mobile?: string } | null)?.mobile ?? lead?.mobile ?? lead?.phone ?? "";
  const last10 = last10Of(rawNumber);
  if (last10.length !== 10) {
    return { error: NextResponse.json({ error: "This enquiry has no usable phone number" }, { status: 409 }) };
  }
  return { supabase, admin, dbUser, enquiry, last10 };
}

// POST /api/enquiries/[id]/not-a-lead
// Body: { label, name? }  the number behind this WhatsApp enquiry is not a prospect (staff, a vendor,
//                         a customer's team member, or something else). The number is remembered so
//                         its later messages never open an enquiry, and every open WhatsApp enquiry
//                         from it is moved to Spam (restorable from the Spam section, as with
//                         POST /api/enquiries/[id]/spam).
// Returns what the DELETE below needs to put everything back.
// Any authenticated user except the read-only viewer, so a wrong call is undone by anyone.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, dbUser, enquiry, last10 } = ctx;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid label" }, { status: 400 });
  const { label, name } = parsed.data;

  const { data: before } = await admin.from("whatsapp_number_labels").select("label, name").eq("last10", last10).maybeSingle();
  const previous = (before as { label: (typeof NUMBER_LABELS)[number]; name: string | null } | null) ?? null;

  const { error: labelErr } = await admin
    .from("whatsapp_number_labels")
    .upsert({ last10, label, name: name || null, created_by: dbUser.id }, { onConflict: "last10" });
  if (labelErr) return NextResponse.json({ error: labelErr.message }, { status: 500 });

  // Every open WhatsApp enquiry of this lead goes to Spam together, so one tap clears the pile.
  const now = new Date().toISOString();
  const stash = { resolved_at: now, resolved_by: dbUser.id, resolution_outcome: "spam" };
  let stashedIds: string[] = [];
  let leadJunked = false;
  if (enquiry.lead_id) {
    const { data: stashed, error } = await admin
      .from("lead_enquiries")
      .update(stash)
      .eq("lead_id", enquiry.lead_id)
      .eq("source", "whatsapp")
      .is("resolved_at", null)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    stashedIds = (stashed ?? []).map((r) => r.id as string);

    // A lead that exists only because of this chatter leaves the Leads list with it.
    const { count: liveEnquiries } = await admin
      .from("lead_enquiries")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", enquiry.lead_id)
      .or("resolution_outcome.is.null,resolution_outcome.neq.spam");
    if (liveEnquiries === 0) {
      const { data: junked } = await admin
        .from("leads")
        .update({ status: "junk" })
        .eq("id", enquiry.lead_id)
        .eq("status", "new")
        .select("id");
      leadJunked = (junked ?? []).length > 0;
    }
    logAudit(supabase, {
      entityType: "lead",
      entityId: enquiry.lead_id as string,
      action: "update",
      performedBy: dbUser.id,
      changes: { whatsapp_number_label: { old: previous?.label ?? null, new: label } },
    });
  } else {
    const { data: stashed, error } = await admin.from("lead_enquiries").update(stash).eq("id", id).is("resolved_at", null).select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    stashedIds = (stashed ?? []).map((r) => r.id as string);
  }

  return NextResponse.json({ success: true, stashed_ids: stashedIds, previous, lead_junked: leadJunked });
}

// DELETE /api/enquiries/[id]/not-a-lead
// Body: { stashed_ids, previous, lead_junked }  the POST result: puts the number's old label back (or
//       removes it), restores the enquiries that call moved to Spam, and un-junks the lead if the call
//       junked it. An enquiry someone has since decided differently is left alone.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, admin, dbUser, enquiry, last10 } = ctx;

  const parsed = undoSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid undo request" }, { status: 400 });
  const { stashed_ids, previous, lead_junked } = parsed.data;

  const { error: labelErr } = previous
    ? await admin
        .from("whatsapp_number_labels")
        .upsert({ last10, label: previous.label, name: previous.name, created_by: dbUser.id }, { onConflict: "last10" })
    : await admin.from("whatsapp_number_labels").delete().eq("last10", last10);
  if (labelErr) return NextResponse.json({ error: labelErr.message }, { status: 500 });

  let restoredIds: string[] = [];
  if (stashed_ids.length > 0) {
    // Scoped to this enquiry's own lead (or itself), so the ids in the body can't reach other leads.
    let query = admin
      .from("lead_enquiries")
      .update({ resolved_at: null, resolved_by: null, resolution_outcome: null })
      .in("id", stashed_ids)
      .eq("resolution_outcome", "spam");
    query = enquiry.lead_id ? query.eq("lead_id", enquiry.lead_id) : query.eq("id", id);
    const { data: restored, error } = await query.select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    restoredIds = (restored ?? []).map((r) => r.id as string);
  }

  if (lead_junked && enquiry.lead_id) {
    await admin.from("leads").update({ status: "new" }).eq("id", enquiry.lead_id).eq("status", "junk");
  }
  if (enquiry.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: enquiry.lead_id as string,
      action: "update",
      performedBy: dbUser.id,
      changes: { whatsapp_number_label: { old: "undone", new: previous?.label ?? null } },
    });
  }

  return NextResponse.json({ success: true, restored_ids: restoredIds });
}
