import type { SupabaseClient } from "@supabase/supabase-js";

/*
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
/**
 * Explicit billing rule: which cases need a paid case invoice before they can
 * execute. Direct clients (no aggregator) and prepaid aggregators do; postpaid
 * aggregators are billed monthly after execution and are exempt. An aggregator
 * with no billing method set keeps the historical exemption.
 */
export type BilledTo = "direct" | "prepaid" | "postpaid" | "unspecified";

export function billedToOf(args: { aggregatorId?: string | null; billingMethod?: string | null }): BilledTo {
  if (!args.aggregatorId) return "direct";
  if (args.billingMethod === "prepaid") return "prepaid";
  if (args.billingMethod === "postpaid") return "postpaid";
  return "unspecified";
}

export function requiresPaidInvoice(billedTo: BilledTo): boolean {
  return billedTo === "direct" || billedTo === "prepaid";
}

export interface PaymentOverride {
  reason: string;
  by: string | null;
  at: string | null;
}

/** Pure decision: true when execution may proceed. An active override always allows. */
export function paymentGateAllows(args: {
  billedTo: BilledTo;
  paid: boolean;
  override: PaymentOverride | null;
}): boolean {
  if (args.override) return true;
  if (!requiresPaidInvoice(args.billedTo)) return true;
  return args.paid;
}

/**
 * Admin override of the payment gate, stored on the case. Returns null when
 * none is active. Tolerates the columns not existing yet (42703): no override.
 */
export async function getPaymentOverride(
  supabase: SupabaseClient,
  caseId: string,
): Promise<PaymentOverride | null> {
  const { data, error } = await supabase
    .from("cases")
    .select("payment_override_reason, payment_override_by, payment_override_at")
    .eq("id", caseId)
    .maybeSingle();
  if (error) {
    if (error.code !== "42703") {
      console.error(`[vo-gate] override lookup failed for case ${caseId}: ${error.message}`);
    }
    return null;
  }
  const row = data as {
    payment_override_reason?: string | null;
    payment_override_by?: string | null;
    payment_override_at?: string | null;
  } | null;
  if (!row?.payment_override_reason) return null;
  return { reason: row.payment_override_reason, by: row.payment_override_by ?? null, at: row.payment_override_at ?? null };
}

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
  const billedTo = billedToOf({ aggregatorId: caseRow?.aggregator_id, billingMethod: aggregator?.billing_method });

  // Only look up payment and override when they can change the answer.
  if (!requiresPaidInvoice(billedTo)) return null;

  const override = await getPaymentOverride(supabase, caseId);
  const paid = override ? false : await caseTermIsPaid(supabase, caseId);
  if (paymentGateAllows({ billedTo, paid, override })) return null;

  return "An invoice must be generated and paid before this agreement can be executed. Use \"Generate Invoice\" on the case, then have accounts issue the Tally GST invoice and the customer pay it.";
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
