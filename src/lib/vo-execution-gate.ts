import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Prepaid aggregators and direct clients (no aggregator) both require a
 * paid VO case invoice before the Leave & License Agreement can execute —
 * see src/lib/case-invoicing.ts. Postpaid aggregators bill monthly after
 * execution, so they're exempt.
 *
 * Shared across every code path that can flip a leave_license
 * case_agreements row to 'executed' — there are four (the generic PATCH
 * mark_executed action, the dedicated leave-license PATCH, manual signed-
 * document upload, and Leegality e-sign completion) because the L&L flow
 * evolved multiple entry points over time. Call this immediately before
 * any of them writes status: 'executed'.
 */
export async function checkVoExecutionPaymentGate(
  supabase: SupabaseClient,
  caseId: string,
): Promise<string | null> {
  const { data: caseRow } = await supabase
    .from("cases")
    .select("aggregator_id, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
    .eq("id", caseId)
    .single();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aggregator = caseRow?.aggregator as any as { billing_method?: string } | null;
  const requiresPaidInvoice = !caseRow?.aggregator_id || aggregator?.billing_method === "prepaid";

  if (!requiresPaidInvoice) return null;

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("payment_status")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_case")
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!statement || statement.payment_status !== "paid") {
    return "An invoice must be generated and paid before this agreement can be executed. Use \"Generate Invoice\" on the case, then have accounts issue the Tally GST invoice and the customer pay it.";
  }
  return null;
}
