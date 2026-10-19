import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

const bodySchema = z.object({ spam: z.boolean() });

// POST /api/enquiries/[id]/spam
// Body: { spam: true }  marks the enquiry as spam: it is resolved with outcome 'spam', which
//                       takes it out of the Enquiry Log, the queue and every count.
//       { spam: false } restores it (only an enquiry that is currently spam).
// Any authenticated user except the read-only viewer, so a wrong call is undone by anyone.
// If the enquiry created its lead (the lead's only enquiry, still "new"), the lead is set to
// junk with it and back to new on restore, so spam doesn't linger in the Leads list either.
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
  if (!parsed.success) return NextResponse.json({ error: "spam must be true or false" }, { status: 400 });
  const { spam } = parsed.data;

  const admin = await createAdminClient();
  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, resolved_at, resolution_outcome")
    .eq("id", id)
    .single();
  if (!old) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });

  if (spam && old.resolved_at) {
    return NextResponse.json({ error: "This enquiry is already resolved" }, { status: 409 });
  }
  if (!spam && old.resolution_outcome !== "spam") {
    return NextResponse.json({ error: "This enquiry is not marked as spam" }, { status: 409 });
  }

  const { error } = await admin
    .from("lead_enquiries")
    .update(
      spam
        ? { resolved_at: new Date().toISOString(), resolved_by: dbUser.id, resolution_outcome: "spam" }
        : { resolved_at: null, resolved_by: null, resolution_outcome: null }
    )
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (old.lead_id) {
    const { count } = await admin
      .from("lead_enquiries")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", old.lead_id);
    if (count === 1) {
      await admin
        .from("leads")
        .update({ status: spam ? "junk" : "new" })
        .eq("id", old.lead_id)
        .eq("status", spam ? "new" : "junk");
    }
    logAudit(supabase, {
      entityType: "lead",
      entityId: old.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        enquiry: { old: old.reference, new: old.reference },
        spam: { old: !spam, new: spam },
      },
    });
  }

  return NextResponse.json({ success: true });
}
