import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { finalizeBillingPayment } from "@/lib/billing-payment-settlement";

/**
 * POST /api/contracts/[id]/deposit-adjustments/[adjustmentId]/reverse —
 * admin-only, single-step (per the filed spec, no second approver on the
 * reversal itself). Restores the deposit balance and, since the RPC deletes
 * the linked billing_payments row, automatically unblocks statement void
 * (void/route.ts's existing "any payments recorded" guard just stops
 * seeing this payment). Also recomputes settlement in case the reversal
 * takes the statement back out of "paid".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adjustmentId: string }> }
) {
  const { id: contractId, adjustmentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can reverse a deposit adjustment" }, { status: 403 });
  }

  const body = await request.json();
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "A reversal reason is required" }, { status: 400 });

  const admin = createAdminClient();

  const { data: adjustment } = await admin
    .from("deposit_adjustments")
    .select("*, statement:billing_statements(id, total_amount, payment_status)")
    .eq("id", adjustmentId)
    .eq("contract_id", contractId)
    .single();

  if (!adjustment) return NextResponse.json({ error: "Adjustment not found" }, { status: 404 });

  const { data: rpcResult, error: rpcError } = await admin.rpc("reverse_deposit_adjustment", {
    p_adjustment_id: adjustmentId,
    p_reversed_by: dbUser.id,
    p_reason: reason,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not reverse adjustment" }, { status: 422 });
  }

  const settlement = await finalizeBillingPayment(admin, {
    statementId: adjustment.billing_statement_id,
    statementTotalAmount: adjustment.statement?.total_amount,
    previousPaymentStatus: adjustment.statement?.payment_status || "unpaid",
    reason: "deposit_adjustment_reversed",
    performedBy: dbUser.id,
  });

  await logAudit(admin, {
    entityType: "deposit_adjustment",
    entityId: adjustmentId,
    action: "deposit_adjustment_reversed",
    performedBy: dbUser.id,
    changes: {
      status: { old: "approved", new: "reversed" },
      reason: { old: null, new: reason },
      payment_status: { old: adjustment.statement?.payment_status, new: settlement.paymentStatus },
    },
  });

  return NextResponse.json({
    data: { id: adjustmentId, status: "reversed" },
    payment_status: settlement.paymentStatus,
  });
}
