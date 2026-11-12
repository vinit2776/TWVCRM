import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Date the proposal's pro-rata invoice was actually paid, or null if unpaid.
 * Single-proposal counterpart to the batched computation in
 * GET /api/proposals (src/app/api/proposals/route.ts) — kept separate
 * because that route optimizes for a whole page of proposals with Maps,
 * while callers like POST /api/contracts only ever need one.
 *
 * Two independent payment paths both count as "pro-rata paid":
 *  1. proposals.payment_status/payment_received_at — set by the generic
 *     proposal Razorpay link webhook AND by the manual /payment route
 *     accounts uses after verifying a bank transfer against the GST
 *     invoice. This is the same flag the contract activation gate checks,
 *     so it's authoritative whenever it's set.
 *  2. The GST invoice's own billing_statements row (created by
 *     send-invoice) getting paid via its own Razorpay link — the payments
 *     webhook only updates billing_statements.payment_status for this
 *     path, never proposals.payment_status, so without this fallback a
 *     contract created right after that payment would show no paid date.
 */
export async function getProrataPaidDate(
  supabase: SupabaseClient,
  proposalId: string
): Promise<string | null> {
  const { data: proposal } = await supabase
    .from("proposals")
    .select("payment_status, payment_received_at")
    .eq("id", proposalId)
    .single();

  if (proposal?.payment_status === "paid" && proposal.payment_received_at) {
    return (proposal.payment_received_at as string).slice(0, 10);
  }

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id")
    .eq("proposal_id", proposalId)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!statement) return null;

  const { data: payment } = await supabase
    .from("billing_payments")
    .select("payment_date")
    .eq("billing_statement_id", statement.id)
    .order("payment_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (payment?.payment_date as string | undefined) ?? null;
}
