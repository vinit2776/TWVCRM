import type { SupabaseClient } from "@supabase/supabase-js";
import { isHandoffV2Enabled, handleStatementPaid } from "@/lib/tally-handoff-server";
import { computeSettlement, type SettlementPaymentStatus } from "@/lib/settlement";
import { advanceCaseStage } from "@/lib/case-status-events";

/**
 * Shared tail of "a payment landed on a statement": recompute settlement
 * status from every billing_payments row, persist it, and — only on the
 * transition into "paid" — fire the same downstream chain the manual
 * Record Payment route always fired (GST invoice auto-gen, or v2 handoff).
 *
 * Extracted so a second payment-creation path (deposit-adjustment approval,
 * which inserts its billing_payments row via an RPC rather than this route)
 * doesn't silently skip settlement/GST-invoice logic. Deliberately excludes
 * the Tally receipt-voucher reverse-sync — that's for real cash movements
 * reconciled against a bank statement, not an internal deposit-to-invoice
 * book entry, which is why the deposit-adjustment feature emails accounts
 * to update Tally manually instead of auto-syncing.
 */
export async function finalizeBillingPayment(
  supabase: SupabaseClient,
  params: {
    statementId: string;
    statementTotalAmount: number | string | null;
    previousPaymentStatus: string;
    reason: string; // passed through to handleStatementPaid for its own logging
    /** The user who recorded this payment, when one exists — surfaced on the
     *  statement timeline's state-change entries. Omit for system-triggered
     *  settlement (Razorpay webhook), which has no human actor. */
    performedBy?: string | null;
  }
): Promise<{
  paymentStatus: SettlementPaymentStatus;
  totalPaid: number;
  balanceDue: number;
  /** Set when reading payments or saving the status failed. The Razorpay
   *  webhook turns this into a non-2xx so Razorpay redelivers. */
  persistError?: string;
}> {
  const { statementId, statementTotalAmount, previousPaymentStatus, reason, performedBy = null } = params;

  const { data: allPayments, error: paymentsErr } = await supabase
    .from("billing_payments")
    .select("amount, tds_amount")
    .eq("billing_statement_id", statementId);

  const settlement = computeSettlement(statementTotalAmount, allPayments);
  const newPaymentStatus = settlement.paymentStatus;

  if (paymentsErr) {
    console.error(`[billing-payment-settlement] Reading payments for ${statementId} failed:`, paymentsErr);
    return { paymentStatus: newPaymentStatus, totalPaid: settlement.totalPaid, balanceDue: settlement.balanceDue, persistError: paymentsErr.message };
  }

  // Conditional on the stored status actually changing, so when two payment
  // paths (or two deliveries of one webhook) settle the same statement at once,
  // only the one that really moved it into "paid" fires the chain below — the
  // GST invoice is generated once, not once per caller.
  let transitioned = false;
  if (newPaymentStatus !== previousPaymentStatus) {
    const { data: changed, error: updateErr } = await supabase
      .from("billing_statements")
      .update({ payment_status: newPaymentStatus })
      .eq("id", statementId)
      .or(`payment_status.is.null,payment_status.neq.${newPaymentStatus}`)
      .select("id");
    if (updateErr) {
      console.error(`[billing-payment-settlement] Saving payment status for ${statementId} failed:`, updateErr);
      return { paymentStatus: newPaymentStatus, totalPaid: settlement.totalPaid, balanceDue: settlement.balanceDue, persistError: updateErr.message };
    }
    transitioned = (changed?.length ?? 0) > 0;
  }

  if (newPaymentStatus === "paid" && transitioned) {
    // Every route that settles a payment funnels through here, so this is the
    // one place a VO case's stage needs to learn about it.
    const { data: stmt } = await supabase
      .from("billing_statements")
      .select("case_id, statement_type")
      .eq("id", statementId)
      .maybeSingle();
    if (stmt?.case_id && stmt.statement_type === "vo_case") {
      await advanceCaseStage(supabase, stmt.case_id as string, "paid");
    }

    const v2Enabled = await isHandoffV2Enabled(supabase);
    if (v2Enabled) {
      await handleStatementPaid(supabase, statementId, reason, performedBy);
    } else {
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        fetch(`${appUrl}/api/billing-statements/${statementId}/generate-gst-invoice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.CRON_SECRET || "",
          },
          body: JSON.stringify({ skipAuth: true }),
        }).catch((err) => console.error("[billing-payment-settlement] GST invoice auto-gen failed:", err));
      } catch (err) {
        console.error("[billing-payment-settlement] Could not trigger GST invoice generation:", err);
      }
    }
  }

  return {
    paymentStatus: newPaymentStatus,
    totalPaid: settlement.totalPaid,
    balanceDue: settlement.balanceDue,
  };
}
