import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { isReviewOutcome } from "@/lib/process-registry";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/process-deviations/[id] — close the loop on a recorded deviation.
 * A flag nobody reviews is noise, so each one gets an outcome: coaching done,
 * the process needs fixing, or it was fine as it stood.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can review" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { outcome?: unknown; note?: unknown };
  if (!isReviewOutcome(body.outcome)) {
    return NextResponse.json({ error: "Pick an outcome" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("process_deviations")
    .update({
      reviewed_by: dbUser.id,
      reviewed_at: new Date().toISOString(),
      review_outcome: body.outcome,
      review_note: note || null,
    })
    .eq("id", id)
    .is("reviewed_at", null)
    .select("id, entity_type, entity_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) {
    return NextResponse.json({ error: "Already reviewed, or not found" }, { status: 409 });
  }

  void logAudit(admin, {
    entityType: "booking",
    entityId: updated.entity_id,
    action: "update",
    performedBy: dbUser.id,
    changes: { deviation_reviewed: { old: null, new: body.outcome } },
  });

  return NextResponse.json({ ok: true });
}
