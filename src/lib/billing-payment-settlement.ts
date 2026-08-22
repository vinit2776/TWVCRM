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
  }
): Promise<{ paymentStatus: SettlementPaymentStatus; totalPaid: number; balanceDue: number }> {
  const { statementId, statementTotalAmount, previousPaymentStatus, reason } = params;

  const { data: allPayments } = await supabase
    .from("billing_payments")
    .select("amount, tds_amount")
    .eq("billing_statement_id", statementId);

  const settlement = computeSettlement(statementTotalAmount, allPayments);
  const newPaymentStatus = settlement.paymentStatus;

  if (newPaymentStatus !== previousPaymentStatus) {
    await supabase
      .from("billing_statements")
      .update({ payment_status: newPaymentStatus })
      .eq("id", statementId);
  }

  if (newPaymentStatus === "paid" && previousPaymentStatus !== "paid") {
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
      await handleStatementPaid(supabase, statementId, reason);
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
