import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { enqueueTallyCreditNote } from "@/lib/tally/enqueue";
import { z } from "zod";

/**
 * POST /api/billing-statements/[id]/cancel-tally
 *
 * CRM-first cancel of a TALLY-issued GST invoice (Phase 1b). A Tally invoice is on
 * Tally's books and cannot be plain-voided (blocked in /void, D5). This enqueues a
 * Credit Note for the bridge to post in Tally; the statement is only marked voided
 * once Tally confirms the reversal (see the credit_note branch in /api/tally/ack).
 *
 * Admin only. Requires a reason. Does NOT immediately void — it queues the reversal.
 */
const BodySchema = z.object({
  reason: z.string().min(5, "A cancellation reason (min 5 chars) is required"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can cancel a Tally-issued invoice" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { reason } = parsed.data;

  const admin = createAdminClient();
  const { data: statement } = await admin
    .from("billing_statements")
    .select("id, status, issuance_channel, tally_invoice_number, lifecycle_stage")
    .eq("id", id)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  // Guards
  if (statement.issuance_channel !== "tally" || !statement.tally_invoice_number) {
    return NextResponse.json(
      { error: "This statement was not issued by Tally. Use the normal void action." },
      { status: 400 },
    );
  }
  if (statement.status === "voided") {
    return NextResponse.json({ error: "Statement is already voided" }, { status: 409 });
  }
  if (statement.lifecycle_stage === "cancelling" || statement.lifecycle_stage === "cancelled") {
    return NextResponse.json(
      { error: "A cancellation is already in progress or done for this invoice." },
      { status: 409 },
    );
  }

  const result = await enqueueTallyCreditNote(id, reason);
  if (!result.ok) {
    const msg = result.reason === "sync_off"
      ? "Tally sync is paused — resume it so the bridge can post the credit note, then retry."
      : result.reason === "not_tally"
        ? "This statement was not issued by Tally. Use the normal void action."
        : "Could not queue the credit note. Please retry.";
    return NextResponse.json({ error: msg, reason: result.reason }, { status: 409 });
  }

  void logAudit(admin, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      lifecycle_stage: { old: statement.lifecycle_stage, new: "cancelling" },
      cancel_via_credit_note: { old: null, new: reason },
    },
  });

  return NextResponse.json({
    ok: true,
    queued: true,
    message: "Credit note queued. The invoice will be marked cancelled once Tally confirms the reversal.",
  });
}
