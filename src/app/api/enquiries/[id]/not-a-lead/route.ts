import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { NUMBER_LABELS, last10Of } from "@/lib/whatsapp-gate";

const bodySchema = z.object({
  label: z.enum(NUMBER_LABELS),
  name: z.string().trim().max(80).optional(),
});

// POST /api/enquiries/[id]/not-a-lead
// Body: { label, name? }  the number behind this WhatsApp enquiry is not a prospect (staff, a vendor,
//                         a customer's team member, or something else). The number is remembered so
//                         its later messages are stored but never open an enquiry, and every open
//                         WhatsApp enquiry from it is moved to Spam (restorable from the Spam
//                         section, as with POST /api/enquiries/[id]/spam).
// Any authenticated user except the read-only viewer, so a wrong call is undone by anyone.
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
  if (!parsed.success) return NextResponse.json({ error: "Invalid label" }, { status: 400 });
  const { label, name } = parsed.data;

  const admin = await createAdminClient();
  const { data: enquiry } = await admin
    .from("lead_enquiries")
    .select("id, source, lead_id, payload, lead:leads(mobile, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!enquiry) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  if (enquiry.source !== "whatsapp") {
    return NextResponse.json({ error: "Only WhatsApp enquiries can be labelled by number" }, { status: 409 });
  }

  const lead = (Array.isArray(enquiry.lead) ? enquiry.lead[0] : enquiry.lead) as { mobile: string | null; phone: string | null } | null;
  const rawNumber = (enquiry.payload as { mobile?: string } | null)?.mobile ?? lead?.mobile ?? lead?.phone ?? "";
  const last10 = last10Of(rawNumber);
  if (last10.length !== 10) return NextResponse.json({ error: "This enquiry has no usable phone number" }, { status: 409 });

  const { error: labelErr } = await admin
    .from("whatsapp_number_labels")
    .upsert({ last10, label, name: name || null, created_by: dbUser.id }, { onConflict: "last10" });
  if (labelErr) return NextResponse.json({ error: labelErr.message }, { status: 500 });

  // Every open WhatsApp enquiry of this lead goes to Spam together, so one tap clears the pile.
  let stashedIds: string[] = [];
  if (enquiry.lead_id) {
    const { data: stashed, error } = await admin
      .from("lead_enquiries")
      .update({ resolved_at: new Date().toISOString(), resolved_by: dbUser.id, resolution_outcome: "spam" })
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
      await admin.from("leads").update({ status: "junk" }).eq("id", enquiry.lead_id).eq("status", "new");
    }
    logAudit(supabase, {
      entityType: "lead",
      entityId: enquiry.lead_id as string,
      action: "update",
      performedBy: dbUser.id,
      changes: { whatsapp_number_label: { old: null, new: label } },
    });
  } else {
    const { error } = await admin
      .from("lead_enquiries")
      .update({ resolved_at: new Date().toISOString(), resolved_by: dbUser.id, resolution_outcome: "spam" })
      .eq("id", id)
      .is("resolved_at", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    stashedIds = [id];
  }

  return NextResponse.json({ success: true, stashed_ids: stashedIds });
}
