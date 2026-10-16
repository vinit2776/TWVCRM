import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canRollback, rollbackReasonSchema } from "@/lib/procurement/admin-rollback";

const bodySchema = z.object({ reason: rollbackReasonSchema });

// reverse_vendor_bill_payment raises these as the exception message (00597).
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  PAYMENT_NOT_FOUND: { status: 404, message: "Payment not found" },
  PAYMENT_ALREADY_REVERSED: { status: 409, message: "This payment has already been reversed" },
  TDS_DEPOSITED: {
    status: 422,
    message: "The TDS on this payment is already deposited on a challan. Handle the challan first, then reverse the payment.",
  },
};

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

  const lockedChain = await chainLockedResponse(supabase, { billId: id });
  if (lockedChain) return lockedChain;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "A reason is required" },
      { status: 400 }
    );
  }

  // The payment must belong to the bill in the URL — the RPC keys on payment id alone.
  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("vendor_bill_payments")
    .select("id, bill_id, amount, payment_mode, payment_reference, payment_date")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment || payment.bill_id !== id) {
    return NextResponse.json({ error: "Payment not found on this bill" }, { status: 404 });
  }

  const { data: result, error } = await admin.rpc("reverse_vendor_bill_payment", {
    p_payment_id: paymentId,
    p_actor: dbUser.id,
    p_reason: parsed.data.reason,
  });

  if (error) {
    const known = Object.entries(RPC_ERRORS).find(([code]) => error.message.includes(code));
    if (known) return NextResponse.json({ error: known[1].message }, { status: known[1].status });
    console.error(`[bills/${id}] reverse payment failed:`, error.message);
    return NextResponse.json({ error: "Could not reverse the payment" }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      rollback_kind: { old: null, new: "payment_reversed" },
      rollback_reason: { old: null, new: parsed.data.reason },
      amount_reversed: { old: null, new: payment.amount },
      payment_reference: { old: payment.payment_reference, new: null },
      amount_paid: { old: result?.previous?.amount_paid, new: result?.amount_paid },
      payment_status: { old: result?.previous?.payment_status, new: result?.payment_status },
      petty_cash_credited: { old: null, new: result?.petty_cash_credited ?? 0 },
      tds_reversed: { old: null, new: result?.tds_reversed ?? 0 },
    },
  });

  return NextResponse.json({ data: result });
}
