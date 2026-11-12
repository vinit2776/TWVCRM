import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { openEnquiryFromHeld, type HeldLead } from "@/lib/whatsapp-intake";
import { NUMBER_LABELS } from "@/lib/whatsapp-gate";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lead") }),
  z.object({ action: z.literal("not_lead") }),
  z.object({ action: z.literal("label"), label: z.enum(NUMBER_LABELS), name: z.string().trim().max(80).optional() }),
]);

// POST /api/whatsapp/possible-leads/[id]
// { action: "lead" }                    opens a real enquiry (and lead) from the held messages
// { action: "not_lead" }                dismisses it and remembers the number as "not a lead"
// { action: "label", label, name? }     dismisses it and remembers the number under that label
// Any authenticated user except the read-only viewer. Nothing is deleted: a dismissed
// conversation stays in the table, and its messages are in the WhatsApp message log.
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
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const body = parsed.data;

  const admin = await createAdminClient();
  const { data: held } = await admin
    .from("whatsapp_possible_leads")
    .select("id, last10, mobile, profile_name, message_type, messages, status")
    .eq("id", id)
    .maybeSingle();
  if (!held) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (held.status !== "held") return NextResponse.json({ error: "Someone already decided this one" }, { status: 409 });

  if (body.action === "lead") {
    const opened = await openEnquiryFromHeld(admin, held as HeldLead, { decidedBy: dbUser.id });
    if (!opened) return NextResponse.json({ error: "Someone already decided this one" }, { status: 409 });
    void logAudit(supabase, { entityType: "lead", entityId: opened.leadId, action: "create", performedBy: dbUser.id });
    return NextResponse.json({ success: true, lead_id: opened.leadId, reference: opened.reference });
  }

  const label = body.action === "label" ? body.label : "not_lead";
  const name = body.action === "label" ? body.name || null : null;
  const { data: dismissed } = await admin
    .from("whatsapp_possible_leads")
    .update({ status: "dismissed", decided_by: dbUser.id, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "held")
    .select("id");
  if (!dismissed || dismissed.length === 0) return NextResponse.json({ error: "Someone already decided this one" }, { status: 409 });

  const { error } = await admin
    .from("whatsapp_number_labels")
    .upsert({ last10: held.last10, label, name, created_by: dbUser.id }, { onConflict: "last10" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
