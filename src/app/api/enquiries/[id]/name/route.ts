import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { splitName } from "@/lib/whatsapp-intake";

const bodySchema = z.object({ name: z.string().trim().min(1).max(80) });

// POST /api/enquiries/[id]/name  { name }
// Names the person behind an enquiry in one step, from the Enquiry Log or the queue, instead of
// opening the contact form. It renames the LEAD (so proposals, contracts and the whole CRM show
// it) and keeps the enquiry's own copy in step. Any authenticated user except the read-only viewer.
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
  if (!parsed.success) return NextResponse.json({ error: "Enter a name (up to 80 characters)" }, { status: 400 });

  const admin = await createAdminClient();
  const { data: enquiry } = await admin.from("lead_enquiries").select("reference, lead_id, payload").eq("id", id).single();
  if (!enquiry) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  if (!enquiry.lead_id) return NextResponse.json({ error: "This enquiry has no lead to name" }, { status: 409 });

  const { data: lead } = await admin.from("leads").select("first_name, last_name").eq("id", enquiry.lead_id).single();
  const { first, last } = splitName(parsed.data.name);
  const { error } = await admin.from("leads").update({ first_name: first, last_name: last }).eq("id", enquiry.lead_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Keep the enquiry's copy in step and drop the now-used suggestion. Writing the row also makes
  // the live queue refresh itself, since it listens for changes to lead_enquiries.
  const payload: Record<string, unknown> = { ...((enquiry.payload ?? {}) as Record<string, unknown>), name: parsed.data.name };
  delete payload.suggested_name;
  await admin.from("lead_enquiries").update({ payload }).eq("id", id);

  logAudit(supabase, {
    entityType: "lead",
    entityId: enquiry.lead_id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      enquiry: { old: enquiry.reference, new: enquiry.reference },
      first_name: { old: lead?.first_name ?? null, new: first },
      last_name: { old: lead?.last_name ?? null, new: last },
    },
  });
  return NextResponse.json({ success: true });
}
