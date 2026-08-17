import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/discard
 *
 * Discards a draft billing statement that should never have existed — a draft
 * generated against the wrong contract/period, or a void-replacement draft
 * that is no longer wanted (contract cancelled, client left, statement
 * re-issued by another route).
 *
 * This is the draft-stage counterpart to void. Void cancels a document the
 * client has already seen and leaves a replacement draft behind; discard
 * removes a working copy nobody has seen and leaves nothing behind, freeing
 * the period so the generator can rebuild it from scratch on the next run.
 *
 * Guards:
 *   • admin / manager / accounts
 *   • Draft status only — anything finalized or beyond goes through void
 *   • Blocked if any payment has been recorded (defensive: a draft should
 *     never have one, but a payment on a discarded row would be orphaned)
 *   • Reason required, audited
 *
 * Side effects (identical to void's un-linking, and just as load-bearing):
 *   usage charges → pending, bookings → unbilled, service usage records →
 *   is_billed = false. Without this the charges stay attached to a row that
 *   no longer bills anything and are silently never billed again.
 */
const DISCARD_ROLES = ["admin", "manager", "accounts"];

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

  if (!dbUser || !DISCARD_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin, manager or accounts can discard a draft" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { discard_reason?: string };
  const discardReason = body.discard_reason?.trim();

  if (!discardReason) {
    return NextResponse.json({ error: "A reason for discarding is required" }, { status: 400 });
  }

  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("id, status, statement_number, notes, voided_statement_id, contract_id, period_start, period_end, total_amount")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (statement.status !== "draft") {
    return NextResponse.json(
      {
        error: statement.status === "discarded"
          ? "This draft has already been discarded."
          : `Only drafts can be discarded — this statement is "${statement.status}". Use Void & Re-issue instead.`,
      },
      { status: 400 }
    );
  }

  // Defensive: a draft was never sent, so it should have no payments. If one
  // exists (recorded manually against the wrong statement, say), discarding
  // would strand it — make the operator deal with the payment first.
  const { data: payments } = await supabase
    .from("billing_payments")
    .select("id, amount")
    .eq("billing_statement_id", id);

  if (payments && payments.length > 0) {
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
    return NextResponse.json(
      {
        error: `Cannot discard — ₹${totalPaid.toLocaleString("en-IN")} in payments recorded against this draft. Reverse the payment first.`,
        payments_count: payments.length,
        total_paid: totalPaid,
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  const { error: discardErr } = await supabase
    .from("billing_statements")
    .update({
      status: "discarded",
      discarded_at: now,
      discarded_by: dbUser.id,
      discard_reason: discardReason,
      notes: [
        statement.notes,
        `--- DISCARDED ${new Date().toLocaleDateString("en-IN")} ---`,
        `Reason: ${discardReason}`,
      ].filter(Boolean).join("\n"),
    })
    .eq("id", id);

  if (discardErr) {
    return NextResponse.json({ error: discardErr.message }, { status: 500 });
  }

  // Release everything the draft had claimed, so the charges land on whatever
  // statement bills this period next. Mirrors void steps 2a–2c.
  await supabase
    .from("usage_charges")
    .update({ billing_statement_id: null, status: "pending" })
    .eq("billing_statement_id", id);

  await supabase
    .from("bookings")
    .update({ billing_statement_id: null })
    .eq("billing_statement_id", id);

  await supabase
    .from("service_usage_records")
    .update({ billing_statement_id: null, is_billed: false })
    .eq("billing_statement_id", id);

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "draft", new: "discarded" },
      discard_reason: { old: null, new: discardReason },
      // A void-replacement draft carries the chain back to the original. Keep
      // it in the audit entry so "voided, then the replacement was thrown
      // away" is readable without joining rows.
      ...(statement.voided_statement_id
        ? { discarded_replacement_of: { old: null, new: statement.voided_statement_id } }
        : {}),
    },
  });

  return NextResponse.json({
    discarded_statement_id: id,
    was_void_replacement: Boolean(statement.voided_statement_id),
    message: statement.voided_statement_id
      ? "Replacement draft discarded. The original stays voided and this period is now free to regenerate."
      : "Draft discarded. This period is now free to regenerate.",
  });
}
