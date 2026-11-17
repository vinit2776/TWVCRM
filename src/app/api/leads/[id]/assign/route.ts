import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/in-app-notifications";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";

const bodySchema = z.object({
  /** The new handler. Leave out to claim the lead for yourself. */
  assigned_to: z.string().uuid().optional(),
});

// POST /api/leads/[id]/assign
// Claims an unhandled lead, or hands a lead to someone else. The handler is the person every
// pending follow-up and reminder on the lead goes to (see src/lib/followup-recipient.ts). Past
// activities keep the name of whoever did them; only this handover is logged, as its own line.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: lead } = await supabase
    .from("leads")
    .select("id, first_name, last_name, company, assigned_to, archived_at, assigned_user:users!leads_assigned_to_fkey(id, full_name)")
    .eq("id", id)
    .single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (lead.archived_at) {
    return NextResponse.json({ error: "This lead is archived. Restore it before changing who handles it" }, { status: 409 });
  }

  const targetId = parsed.data.assigned_to ?? me.id;
  if (targetId === lead.assigned_to) {
    return NextResponse.json({ error: "That person is already handling this lead" }, { status: 409 });
  }

  // Who may do this: admins and managers for any lead; a sales rep for a lead that is theirs, or
  // that nobody handles yet (that is claiming).
  const isHandler = lead.assigned_to === me.id;
  const allowed =
    me.role === "admin" ||
    me.role === "manager" ||
    (me.role === "sales_rep" && (isHandler || !lead.assigned_to));
  if (!allowed) {
    return NextResponse.json({ error: "Only the person handling this lead, or a manager, can hand it over" }, { status: 403 });
  }

  const { data: target } = await supabase
    .from("users")
    .select("id, role, full_name, is_active")
    .eq("id", targetId)
    .single();
  if (!target || !target.is_active || !(LEAD_HANDLER_ROLES as readonly string[]).includes(target.role)) {
    return NextResponse.json({ error: "That person can't handle leads" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("leads")
    .update({ assigned_to: targetId })
    .eq("id", id)
    .select("*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const previous = (lead.assigned_user as { full_name?: string } | null)?.full_name ?? null;
  const claimed = !previous && targetId === me.id;

  // The line in the lead's history. It is written under the person who made the change.
  const { error: noteError } = await supabase.from("activities").insert({
    lead_id: id,
    type: "note",
    subject: claimed ? "Claimed" : "Reassigned",
    description: claimed ? `${target.full_name} took this lead` : `${previous ?? "Nobody"} → ${target.full_name}`,
    created_by: me.id,
  });
  if (noteError) console.error("[assign] history line failed", noteError.code, noteError.message);

  // Open public-form enquiries on the lead follow the handler, so the enquiry card names the same person.
  const admin = createAdminClient();
  const { error: enquiryError } = await admin
    .from("lead_enquiries")
    .update({ claimed_by: targetId, claimed_at: new Date().toISOString() })
    .eq("lead_id", id)
    .is("resolved_at", null);
  if (enquiryError) console.error("[assign] enquiry claim failed", enquiryError.code, enquiryError.message);

  logAudit(supabase, {
    entityType: "lead",
    entityId: id,
    action: "update",
    performedBy: me.id,
    changes: { assigned_to: { old: lead.assigned_to ?? null, new: targetId } },
  });

  // Tell the new handler, in the app only (no WhatsApp on a handover).
  if (targetId !== me.id) {
    const leadName =
      lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "a lead";
    await createNotification({
      userId: targetId,
      type: "lead_assigned",
      title: "A lead was handed to you",
      body: `${me.full_name} gave you ${leadName}`,
      url: `/leads/${id}`,
      entityType: "lead",
      entityId: id,
    });
  }

  return NextResponse.json({ data: updated });
}
