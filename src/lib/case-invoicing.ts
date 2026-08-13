/**
 * Per-case Virtual Office invoicing — prepaid aggregators and direct clients.
 *
 * Both flows gate the case's Leave & License agreement execution on payment
 * (see src/app/api/cases/[id]/agreement/route.ts). Which sequence gets there
 * depends on billing_mode: proforma_first dispatches a PI with a Razorpay
 * link immediately, real GST invoice issued once paid; gst_direct issues no
 * proforma — the statement sits in the Tally Inbox until an accountant
 * uploads the real GST invoice, and only then does a Razorpay link +
 * customer email go out (src/app/api/billing-statements/[id]/upload-gst-invoice/route.ts).
 * Aggregator-sourced cases follow their aggregator's billing_mode;
 * direct-client cases carry their own (defaults to proforma_first — a
 * walk-in customer shouldn't have to wait on an accountant just to get a
 * payment link).
 *
 * Contrast with postpaid aggregators (src/lib/aggregator-invoicing.ts),
 * which consolidates many cases into one aggregator-billed statement, and
 * VO renewals (src/lib/vo-renewal.ts), which bill recurring periods after
 * a case is already active.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";
import { dispatchProforma } from "@/lib/send-proforma";
import { logAudit } from "@/lib/audit";

interface CaseForInvoicing {
  id: string;
  rate: number | null;
  start_date: string | null;
  tenure_months: number | null;
  case_source: "aggregator" | "direct";
  bill_to: "aggregator" | "client" | null;
  client_gst_number: string | null;
  client_name: string;
  client_company_name: string | null;
  // Direct-client cases only — no aggregator to hold a mode, so the case
  // carries its own. Ignored for aggregator-sourced cases (they use the
  // aggregator's billing_mode instead).
  billing_mode?: "proforma_first" | "gst_direct" | null;
  aggregator: {
    gst_number: string | null;
    same_state_as_twv: boolean | null;
    billing_mode?: "proforma_first" | "gst_direct" | null;
  } | null;
}

export class CaseInvoicingError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface CaseInvoiceResult {
  statementId: string;
  billingMode: "proforma_first" | "gst_direct";
  /** True when the statement was created but NOT dispatched — proforma_first
   *  with opts.dispatch === false. Caller must trigger the send separately
   *  (see POST /api/cases/[id]/invoice/send) once the operator confirms. */
  requiresManualSend: boolean;
}

/**
 * Creates the vo_case billing statement for a prepaid-aggregator or
 * direct-client case and routes it into the Tally handoff pipeline.
 * Throws CaseInvoicingError for anything the caller should turn into a 4xx.
 *
 * By default (opts.dispatch !== false) a proforma_first statement is
 * dispatched (emailed + Razorpay link) immediately after creation, same as
 * historical behavior. Pass { dispatch: false } to create the statement
 * without sending it — used by the "preview before send" flow so an
 * operator can review the amount/recipient and add CC emails first.
 */
export async function createCaseInvoiceStatement(
  supabase: SupabaseClient,
  caseData: CaseForInvoicing,
  opts: { dispatch?: boolean } = {},
): Promise<CaseInvoiceResult> {
  if (!caseData.rate || caseData.rate <= 0) {
    throw new CaseInvoicingError("Case has no rate set — cannot generate an invoice.", 400);
  }

  const { data: existing } = await supabase
    .from("billing_statements")
    .select("id")
    .eq("case_id", caseData.id)
    .eq("statement_type", "vo_case")
    .is("voided_at", null)
    .maybeSingle();

  if (existing) {
    throw new CaseInvoicingError("An invoice already exists for this case.", 409);
  }

  const billToAggregator = caseData.case_source === "aggregator" && caseData.bill_to === "aggregator";
  const billToClient = caseData.case_source === "direct" || caseData.bill_to === "client";

  if (caseData.case_source === "aggregator" && !caseData.bill_to) {
    throw new CaseInvoicingError(
      "Bill-to (aggregator or client) must be selected before generating this case's invoice.",
      400,
    );
  }

  const buyerGstin = billToAggregator
    ? caseData.aggregator?.gst_number ?? null
    : billToClient
      ? caseData.client_gst_number ?? null
      : null;

  // Interstate determination mirrors the existing precedent (aggregator
  // invoicing uses aggregator.same_state_as_twv; vo-renewal hardcodes
  // same-state/Tamil Nadu since there's no equivalent flag on cases yet).
  const isInterstate = billToAggregator ? !(caseData.aggregator?.same_state_as_twv ?? true) : false;
  const placeOfSupply = "Tamil Nadu";

  const subtotal = caseData.rate;
  const gstRate = 18;
  const gstAmount = Math.round(subtotal * gstRate) / 100;
  const cgst = isInterstate ? 0 : gstAmount / 2;
  const sgst = isInterstate ? 0 : gstAmount / 2;
  const igst = isInterstate ? gstAmount : 0;
  const total = subtotal + gstAmount;

  // One-time license fee covering the case's full tenure — matches the
  // Leave & License Agreement's single term fee (e.g. "License Fee: Rs.
  // 18,000" for an 11-month term), not a monthly recurring charge. VO
  // renewal statements (src/lib/vo-renewal.ts) only bill again once this
  // whole term is ending, not month-to-month within it.
  const periodStart = caseData.start_date ?? new Date().toISOString().slice(0, 10);
  const tenureMonths = caseData.tenure_months && caseData.tenure_months > 0 ? caseData.tenure_months : 12;
  const periodEndDate = new Date(periodStart);
  periodEndDate.setMonth(periodEndDate.getMonth() + tenureMonths);
  periodEndDate.setDate(periodEndDate.getDate() - 1);
  const periodEnd = periodEndDate.toISOString().slice(0, 10);

  const buyerName = billToAggregator
    ? undefined // aggregator name isn't stored on billing_statements directly; case/aggregator join carries it
    : caseData.client_company_name ?? caseData.client_name;

  const { data: statement, error } = await supabase
    .from("billing_statements")
    .insert({
      case_id: caseData.id,
      period_start: periodStart,
      period_end: periodEnd,
      statement_type: "vo_case",
      created_via: "vo_case_request",
      fixed_amount: subtotal,
      usage_amount: 0,
      subtotal,
      tax_percentage: gstRate,
      tax_amount: gstAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      total_amount: total,
      is_interstate: isInterstate,
      place_of_supply: placeOfSupply,
      buyer_gstin: buyerGstin,
      status: "finalized",
      finalized_at: new Date().toISOString(),
      line_items: [
        {
          type: "prepaid_rent",
          label: "Virtual Office License Fee",
          subtotal,
          items: [
            {
              description: `Virtual Office License Fee${buyerName ? ` — ${buyerName}` : ""}`,
              quantity: 1,
              rate: subtotal,
              amount: subtotal,
            },
          ],
        },
      ],
    })
    .select("id")
    .single();

  if (error || !statement) {
    throw new CaseInvoicingError(`Failed to create case invoice: ${error?.message}`, 500);
  }

  // Aggregator-sourced cases honor the aggregator's choice; direct-client
  // cases carry their own billing_mode (no aggregator to hold one), which
  // defaults to proforma_first at creation.
  const billingMode = caseData.case_source === "aggregator"
    ? (caseData.aggregator?.billing_mode === "proforma_first" ? "proforma_first" : "gst_direct")
    : (caseData.billing_mode === "gst_direct" ? "gst_direct" : "proforma_first");

  const handoff = await handleStatementFinalized(supabase, statement.id, billingMode, "case_invoice_request");

  const shouldAutoDispatch = opts.dispatch !== false;
  let requiresManualSend = false;
  if (billingMode === "proforma_first" && !handoff.skipLegacyDispatch) {
    if (!shouldAutoDispatch) {
      // Caller wants a preview step before sending — leave the statement
      // finalized-but-undispatched; POST /api/cases/[id]/invoice/send
      // triggers the actual dispatch once the operator confirms.
      requiresManualSend = true;
    } else {
      // Previously discarded — a dispatch failure (SMTP/Resend/Razorpay down,
      // no contact info, etc.) was silent: the case invoice still "succeeded"
      // with no record of why the customer never got anything. Log both to
      // Vercel's console (immediate visibility) and the audit trail (queryable
      // after the fact, same as every other mutation in this codebase).
      const dispatchResult = await dispatchProforma(supabase, statement.id);
      if (!dispatchResult.success) {
        console.error(
          `[case-invoicing] dispatchProforma failed for statement ${statement.id} (case ${caseData.id}): ${dispatchResult.error ?? "unknown error"}`,
        );
      }
      void logAudit(supabase, {
        entityType: "billing_statement",
        entityId: statement.id,
        action: "update",
        performedBy: "system:case-invoicing",
        changes: {
          proforma_dispatch: {
            old: null,
            new: {
              success: dispatchResult.success,
              error: dispatchResult.error ?? null,
              emailed_to: dispatchResult.emailedTo,
              razorpay_link_created: !!dispatchResult.razorpayLinkUrl,
              no_contact: dispatchResult.noContact,
            },
          },
        },
      });
    }
  }
  // gst_direct: no dispatch — statement sits in the Tally Inbox until an
  // accountant uploads the real GST invoice (upload-gst-invoice/route.ts).

  return { statementId: statement.id, billingMode, requiresManualSend };
}
