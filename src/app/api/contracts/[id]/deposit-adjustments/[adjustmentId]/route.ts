import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { finalizeBillingPayment } from "@/lib/billing-payment-settlement";
import {
  sendDepositAdjustmentAccountsEmail,
  sendDepositAdjustmentCustomerEmail,
} from "@/lib/deposit-adjustment-emails";

/**
 * PATCH /api/contracts/[id]/deposit-adjustments/[adjustmentId] — approve or
 * reject a pending deposit adjustment.
 *
 * Approve: admin/manager only, and never the original requester — the RPC
 * enforces this as a second layer since a direct RPC call would otherwise
 * skip the check. This one moves money and stays absolute.
 *
 * Reject: admin/manager can reject anyone's request; the original requester
 * can also reject (cancel) their OWN request regardless of role. Self-cancel
 * doesn't move money or self-grant authorization, so it isn't a maker-checker
 * violation — without it, a request from the only admin/manager on staff
 * would have no one able to act on it at all.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adjustmentId: string }> }
) {
  const { id: contractId, adjustmentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const action = body.action; // "approve" | "reject"
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }
  if (action === "reject" && !reason) {
    return NextResponse.json({ error: "A rejection reason is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: adjustment } = await admin
    .from("deposit_adjustments")
    .select("*, statement:billing_statements(id, total_amount, payment_status, statement_number), contract:contracts!deposit_adjustments_contract_id_fkey(contract_number)")
    .eq("id", adjustmentId)
    .eq("contract_id", contractId)
    .single();

  if (!adjustment) return NextResponse.json({ error: "Adjustment not found" }, { status: 404 });

  const isOwnRequest = adjustment.requested_by === dbUser.id;

  if (action === "approve" && !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or manager can approve a deposit adjustment" },
      { status: 403 }
    );
  }
  if (action === "reject" && !isOwnRequest && !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin, manager, or the original requester can reject a deposit adjustment" },
      { status: 403 }
    );
  }

  if (action === "approve") {
    const { data: rpcResult, error: rpcError } = await admin.rpc("approve_deposit_adjustment", {
      p_adjustment_id: adjustmentId,
      p_approved_by: dbUser.id,
    });
    if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

    const result = rpcResult?.[0];
    if (!result?.success) {
      return NextResponse.json({ error: result?.error || "Could not approve adjustment" }, { status: 422 });
    }

    // Recompute settlement + fire the paid-transition chain, same as any
    // other payment mode — the RPC only inserted the billing_payments row.
    const settlement = await finalizeBillingPayment(admin, {
      statementId: adjustment.billing_statement_id,
      statementTotalAmount: adjustment.statement?.total_amount,
      previousPaymentStatus: adjustment.statement?.payment_status || "unpaid",
      reason: "deposit_adjustment_approved",
      performedBy: dbUser.id,
    });

    await logAudit(admin, {
      entityType: "deposit_adjustment",
      entityId: adjustmentId,
      action: "deposit_adjustment_approved",
      performedBy: dbUser.id,
      changes: {
        status: { old: "pending_approval", new: "approved" },
        payment_status: { old: adjustment.statement?.payment_status, new: settlement.paymentStatus },
      },
    });

    // Fetch the balance after approval + contract/lead info for the emails.
    const { data: balance } = await admin.rpc("get_deposit_available_balance", {
      p_contract_id: contractId,
    });
    const availableAfter = balance?.[0]?.available ?? 0;

    const emailCtx = {
      adjustmentId,
      amount: Number(adjustment.amount),
      contractNumber: adjustment.contract?.contract_number || contractId,
      statementNumber: adjustment.statement?.statement_number || adjustment.billing_statement_id,
      depositAvailableAfter: Number(availableAfter),
      approvedByName: dbUser.full_name || "Admin",
    };

    void sendDepositAdjustmentAccountsEmail(admin, emailCtx).then((sent) => {
      if (sent) {
        void admin.from("deposit_adjustments")
          .update({ accounts_notified_at: new Date().toISOString() })
          .eq("id", adjustmentId);
      }
    });

    if (adjustment.notify_customer) {
      const { data: contractWithLead } = await admin
        .from("contracts")
        .select("lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, billing_emails)")
        .eq("id", contractId)
        .single();
      const lead = (contractWithLead as { lead?: { first_name?: string; last_name?: string; company?: string; email?: string; billing_emails?: string[] } } | null)?.lead;
      const billingEmails = (lead?.billing_emails as string[] | null) ?? [];
      const recipients = Array.from(new Set([lead?.email, ...billingEmails].filter(Boolean))) as string[];
      const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";

      void sendDepositAdjustmentCustomerEmail({ ...emailCtx, customerName, to: recipients }).then((sent) => {
        if (sent) {
          void admin.from("deposit_adjustments")
            .update({ customer_notified_at: new Date().toISOString() })
            .eq("id", adjustmentId);
        }
      });
    }

    return NextResponse.json({
      data: { id: adjustmentId, status: "approved", billing_payment_id: result.billing_payment_id },
      payment_status: settlement.paymentStatus,
    });
  }

  // action === "reject"
  const { data: rpcResult, error: rpcError } = await admin.rpc("reject_deposit_adjustment", {
    p_adjustment_id: adjustmentId,
    p_rejected_by: dbUser.id,
    p_reason: reason,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not reject adjustment" }, { status: 422 });
  }

  await logAudit(admin, {
    entityType: "deposit_adjustment",
    entityId: adjustmentId,
    action: "deposit_adjustment_rejected",
    performedBy: dbUser.id,
    changes: { status: { old: "pending_approval", new: "rejected" }, reason: { old: null, new: reason } },
  });

  return NextResponse.json({ data: { id: adjustmentId, status: "rejected" } });
}
