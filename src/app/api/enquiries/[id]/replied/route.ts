import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

// POST /api/enquiries/[id]/replied
// "I answered this on WhatsApp." Replies are typed in the WhatsApp app, which the CRM cannot see,
// so this one tap logs it and clears the enquiry from the Replies tab until the customer writes
// again. Unlike Log update it leaves the enquiry's planned next step alone. Any authenticated
// user (same as claim); on an unclaimed enquiry it also takes it on for the person tapping.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // lead_enquiries / enquiry_updates are read-only to users under RLS; this route writes.
  const admin = await createAdminClient();
  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, claimed_by, resolved_at, source")
    .eq("id", id)
    .single();
  if (!old) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  if (old.resolved_at) return NextResponse.json({ error: "This enquiry is already resolved" }, { status: 409 });

  const { error: insertError } = await admin
    .from("enquiry_updates")
    .insert({ enquiry_id: id, kind: "replied_whatsapp", created_by: dbUser.id });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (!old.claimed_by) {
    await admin.from("lead_enquiries").update({ claimed_by: dbUser.id, claimed_at: new Date().toISOString() }).eq("id", id);
  }

  if (old.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: old.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: { enquiry: { old: old.reference, new: old.reference }, enquiry_update: { old: null, new: "replied_whatsapp" } },
    });
  }
  return NextResponse.json({ success: true });
}
