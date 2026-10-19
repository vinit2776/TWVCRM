import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";

const bodySchema = z.object({
  next_step: z.string().trim().max(500).nullable(),
  // Calendar day (IST) the follow-up is due, or null for none.
  follow_up_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

// POST /api/enquiries/[id]/next-step
// Records what happens next on one enquiry and when. Any authenticated user (same as claim).
// Setting a next step on an unclaimed enquiry claims it for the person setting it, so
// "who is working on it" is never blank once someone has planned the follow-up.
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

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid next step or date" }, { status: 400 });
  }
  const nextStep = parsed.data.next_step ? parsed.data.next_step : null;
  const followUpDate = parsed.data.follow_up_date ?? null;
  if (!nextStep && followUpDate) {
    return NextResponse.json({ error: "Add a next step to go with the follow-up date" }, { status: 400 });
  }

  // lead_enquiries is read-only to users under RLS; this route writes the state.
  const admin = await createAdminClient();
  const { data: old } = await admin
    .from("lead_enquiries")
    .select("reference, lead_id, claimed_by, resolved_at, next_step, follow_up_at")
    .eq("id", id)
    .single();
  if (!old) return NextResponse.json({ error: "Enquiry not found" }, { status: 404 });
  if (old.resolved_at) {
    return NextResponse.json({ error: "This enquiry is already resolved" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    next_step: nextStep,
    follow_up_at: followUpDate ? `${followUpDate}T00:00:00+05:30` : null,
    next_step_by: nextStep ? dbUser.id : null,
    next_step_at: nextStep ? now : null,
  };
  if (nextStep && !old.claimed_by) {
    update.claimed_by = dbUser.id;
    update.claimed_at = now;
  }

  const { error } = await admin.from("lead_enquiries").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (old.lead_id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: old.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        enquiry: { old: old.reference, new: old.reference },
        next_step: { old: old.next_step, new: nextStep },
        follow_up_at: { old: old.follow_up_at, new: update.follow_up_at },
      },
    });
  }

  return NextResponse.json({ success: true });
}
