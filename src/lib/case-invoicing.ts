/**
 * Per-case Virtual Office invoicing — prepaid aggregators and direct clients.
 *
 * Both flows require a real, Tally-issued GST invoice before payment can be
 * collected and the case's Leave & License agreement can execute (see
 * src/app/api/cases/[id]/agreement/route.ts). Never a proforma invoice —
 * this always follows the gst_direct sequence: statement finalizes with no
 * dispatch, sits in the Tally Inbox until an accountant uploads the real
 * invoice, and only then does a Razorpay link + customer email go out
 * (src/app/api/billing-statements/[id]/upload-gst-invoice/route.ts).
 *
 * Contrast with postpaid aggregators (src/lib/aggregator-invoicing.ts),
 * which consolidates many cases into one aggregator-billed statement, and
 * VO renewals (src/lib/vo-renewal.ts), which bill recurring periods after
 * a case is already active.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";
import { dispatchProforma } from "@/lib/send-proforma";

interface CaseForInvoicing {
  id: string;
  rate: number | null;
  start_date: string | null;
  case_source: "aggregator" | "direct";
  bill_to: "aggregator" | "client" | null;
  client_gst_number: string | null;
  client_name: string;
  client_company_name: string | null;
  aggregator: {
    gst_number: string | null;
    same_state_as_twv: boolean | null;
    // Proforma-First vs GST-Direct — direct-client cases have no aggregator
    // and are always gst_direct (see createCaseInvoiceStatement below).
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

/**
 * Creates the vo_case billing statement for a prepaid-aggregator or
 * direct-client case and routes it into the Tally handoff pipeline.
 * Throws CaseInvoicingError for anything the caller should turn into a 4xx.
 */
export async function createCaseInvoiceStatement(
  supabase: SupabaseClient,
  caseData: CaseForInvoicing,
): Promise<string> {
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

  // One-time license fee covering the case's first month — VO renewal
  // statements (src/lib/vo-renewal.ts) take over recurring billing once
  // the case is active.
  const periodStart = caseData.start_date ?? new Date().toISOString().slice(0, 10);
  const periodEndDate = new Date(periodStart);
  periodEndDate.setMonth(periodEndDate.getMonth() + 1);
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

  // Direct-client cases have no aggregator to hold a billing_mode — always
  // gst_direct. Aggregator-sourced cases honor the aggregator's choice.
  const billingMode = caseData.case_source === "aggregator" && caseData.aggregator?.billing_mode === "proforma_first"
    ? "proforma_first"
    : "gst_direct";

  const handoff = await handleStatementFinalized(supabase, statement.id, billingMode, "case_invoice_request");

  if (billingMode === "proforma_first" && !handoff.skipLegacyDispatch) {
    await dispatchProforma(supabase, statement.id);
  }
  // gst_direct: no dispatch — statement sits in the Tally Inbox until an
  // accountant uploads the real GST invoice (upload-gst-invoice/route.ts).

  return statement.id;
}
