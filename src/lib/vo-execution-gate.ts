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

  if (!(await caseTermIsPaid(supabase, caseId))) {
    return "An invoice must be generated and paid before this agreement can be executed. Use \"Generate Invoice\" on the case, then have accounts issue the Tally GST invoice and the customer pay it.";
  }
  return null;
}

/**
 * Whether the term a case covers has been paid for. A first term is paid by
 * its VO case invoice; a renewed term by the renewal bill that created it,
 * which completion moves onto the new case.
 */
async function caseTermIsPaid(supabase: SupabaseClient, caseId: string): Promise<boolean> {
  const { data: statement } = await supabase
    .from("billing_statements")
    .select("payment_status")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_case")
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (statement?.payment_status === "paid") return true;

  const { data: caseRow } = await supabase
    .from("cases")
    .select("is_renewal, start_date")
    .eq("id", caseId)
    .maybeSingle();
  if (!caseRow?.is_renewal || !caseRow.start_date) return false;

  const { data: renewalBill } = await supabase
    .from("billing_statements")
    .select("id")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_renewal")
    .eq("period_start", caseRow.start_date)
    .eq("payment_status", "paid")
    .is("voided_at", null)
    .limit(1)
    .maybeSingle();
  return !!renewalBill;
}
