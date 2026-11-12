import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canRecordPayments } from "@/lib/constants";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/hold
 *
 * Temporarily blocks a statement from being sent/GST-issued while something
 * on it is being clarified or corrected. The draft itself stays editable —
 * only dispatchProforma/dispatchGstDirect and generate-gst-invoice check
 * held_at. Distinct from a moratorium (contract_billing_moratoriums), which
 * waives an entire billing month rather than pausing one statement.
 *
 * Guards:
 *   • accounts/admin only (same roles as recording a payment)
 *   • Statement must be draft or finalized — nothing to hold once it's
 *     already sent (exported) or already terminal (voided/discarded)
 *   • Not already held
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !canRecordPayments(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can place a hold on a billing statement" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { hold_reason?: string };
  const holdReason = body.hold_reason?.trim();

  if (!holdReason) {
    return NextResponse.json({ error: "A reason for the hold is required" }, { status: 400 });
  }

  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("id, status, held_at")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (statement.held_at) {
    return NextResponse.json({ error: "Statement is already on hold" }, { status: 422 });
  }

  if (!["draft", "finalized"].includes(statement.status)) {
    return NextResponse.json(
      { error: `Cannot hold a statement with status "${statement.status}". Only draft or finalized statements can be held.` },
      { status: 422 }
    );
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("billing_statements")
    .update({ held_at: now, held_by: dbUser.id, hold_reason: holdReason })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "statement_held",
    performedBy: dbUser.id,
    changes: { hold_reason: { old: null, new: holdReason } },
  });

  return NextResponse.json(updated);
}
