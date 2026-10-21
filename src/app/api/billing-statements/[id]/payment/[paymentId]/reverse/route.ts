import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canRollback, rollbackReasonSchema } from "@/lib/procurement/admin-rollback";

const bodySchema = z.object({ reason: rollbackReasonSchema });

// reverse_billing_payment raises these as the exception message (00633).
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  STATEMENT_NOT_FOUND: { status: 404, message: "Statement not found" },
  PAYMENT_NOT_FOUND: { status: 404, message: "Payment not found on this statement" },
  GATEWAY_PAYMENT: {
    status: 422,
    message: "This payment came through Razorpay, so real money moved. Refund it in Razorpay instead of reversing it here.",
  },
  TALLY_RECEIPT_RECORDED: {
    status: 422,
    message: "A receipt for this payment is already recorded in Tally. Cancel the receipt in Tally first.",
  },
  TDS_RECORDED: {
    status: 422,
    message: "TDS on this payment is already filed or certified. Handle the TDS entry first.",
  },
  DEPOSIT_ADJUSTMENT_PAYMENT: {
    status: 422,
    message: "This payment is a deposit adjustment. Reverse it from the contract's Deposit adjustments instead.",
  },
  STATEMENT_CLOSED: {
    status: 422,
    message: "This statement is voided, discarded or written off, so its payments can't be changed.",
  },
  STATEMENT_ACCOUNTED: {
    status: 422,
    message: "This statement is already marked accounted. Unmark it in accounting before reversing a payment.",
  },
  PERIOD_LOCKED: {
    status: 422,
    message: "The accounting period for this statement is locked. Unlock it before reversing a payment.",
  },
  LINKED_DOCUMENT: {
    status: 422,
    message:
      "This statement belongs to a proposal, ad-hoc invoice or Virtual Office case, whose own status also moved when the payment was recorded. It needs a manual fix so those stay in step.",
  },
  HANDOFF_CLOSED: {
    status: 422,
    message: "This statement's Tally handoff has already been closed by accounts. Reopen it with accounts before reversing the payment.",
  },
};

/**
 * POST /api/billing-statements/[id]/payment/[paymentId]/reverse
 *
 * Admin-only correction for a customer payment recorded in error (e.g. a bank
 * receipt that never arrived). Reason is required and saved to the audit trail
 * and to billing_payment_reversals with the full original payment row. All the
 * guards and the state reset live in the reverse_billing_payment RPC (00633).
 *
 * Sends nothing to the customer — no email, SMS or link is touched.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  const { id, paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!canRollback(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin can reverse a payment" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "A reason is required" },
      { status: 400 }
    );
  }

  const { data: result, error } = await createAdminClient().rpc("reverse_billing_payment", {
    p_statement_id: id,
    p_payment_id: paymentId,
    p_actor: dbUser.id,
    p_reason: parsed.data.reason,
  });

  if (error) {
    const known = Object.entries(RPC_ERRORS).find(([code]) => error.message.includes(code));
    if (known) return NextResponse.json({ error: known[1].message, code: known[0] }, { status: known[1].status });
    console.error(`[billing-statements/${id}] reverse payment failed:`, error.message);
    return NextResponse.json({ error: "Could not reverse the payment" }, { status: 500 });
  }

  const payment = result?.payment ?? {};
  await logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      rollback_kind: { old: null, new: "customer_payment_reversed" },
      rollback_reason: { old: null, new: parsed.data.reason },
      payment_reversed: {
        old: `${payment.payment_mode ?? "—"} ₹${payment.amount ?? "—"} ref:${payment.payment_reference ?? "—"}`,
        new: null,
      },
      payment_status: { old: result?.previous?.payment_status, new: result?.payment_status },
      handoff_state: { old: result?.previous?.handoff_state ?? null, new: result?.handoff_state ?? null },
    },
  });

  return NextResponse.json({
    payment_status: result?.payment_status,
    handoff_state: result?.handoff_state ?? null,
    total_paid: result?.total_paid,
    balance_due: result?.balance_due,
  });
}
