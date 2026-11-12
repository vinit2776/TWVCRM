import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

const bodySchema = z.object({ decision: z.literal("enquiry") });

// POST /api/enquiries/[id]/triage  { decision: "enquiry" }
// Confirms an enquiry the automatic triage flagged "needs review" as a real enquiry, which
// clears the flag. ("Not an enquiry" goes through POST /api/enquiries/[id]/spam.)
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
  if (!bodySchema.safeParse(await request.json().catch(() => null)).success) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }

  const admin = await createAdminClient();
  const { data: row } = await admin.from("lead_enquiries").select("reference, lead_id, payload").eq("id", id).single();
  if (!row) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  const payload = (row.payload ?? {}) as { triage?: Record<string, unknown> };
  if (!payload.triage) return NextResponse.json({ error: "This enquiry has nothing to review" }, { status: 409 });

  const { error } = await admin
    .from("lead_enquiries")
    .update({ payload: { ...payload, triage: { ...payload.triage, reviewed: { by: dbUser.id, at: new Date().toISOString(), decision: "enquiry" } } } })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (row.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: row.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: { enquiry: { old: row.reference, new: row.reference }, triage_review: { old: "needs_review", new: "confirmed_enquiry" } },
    });
  }
  return NextResponse.json({ success: true });
}
