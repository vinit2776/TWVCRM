/**
 * Ad-hoc charges on a Virtual Office case.
 *
 * Any additional billing for a case, as required — anything the licence fee
 * (vo_case) and the renewal (vo_renewal) do not already cover. The caller
 * supplies the description and amount; nothing here prescribes a list of
 * charge types.
 *
 * Buyer resolution is deliberately shared with the case invoice
 * (computeCaseInvoice) rather than reimplemented: postpaid aggregators are
 * billed regardless of bill_to, prepaid honours bill_to, direct clients bill
 * themselves. An ad-hoc charge that billed a different party from the licence
 * fee on the same case would be a bug, not a feature — with one exception,
 * billToOverride, for a charge the client caused on a partner-billed case.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { caseDisplayName } from "@/lib/case-workflow";

export class AdhocChargeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface AdhocChargeCase {
  id: string;
  case_number: string;
  case_source: "aggregator" | "direct";
  bill_to: "aggregator" | "client" | null;
  client_name: string;
  client_company_name: string | null;
  client_gst_number: string | null;
  aggregator_id: string | null;
  aggregator: {
    name?: string | null;
    gst_number: string | null;
    same_state_as_twv: boolean | null;
    billing_method?: string | null;
  } | null;
}

export interface AdhocChargeInput {
  description: string;
  amount: number;
  notes?: string | null;
  /** Bill this one charge to the client even on a partner-billed case. */
  billToOverride?: "client" | null;
}

export interface AdhocChargePreview {
  billTo: "aggregator" | "client";
  buyerName: string;
  buyerGstin: string | null;
  endClientName: string;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  isInterstate: boolean;
  placeOfSupply: string;
}

/**
 * Resolves who an ad-hoc charge bills and what it comes to. Pure — reads and
 * writes nothing, so the confirm dialog and the create path cannot disagree.
 */
export function computeAdhocCharge(
  caseData: AdhocChargeCase,
  input: AdhocChargeInput,
): AdhocChargePreview {
  if (!input.description?.trim()) {
    throw new AdhocChargeError("A description is required for an ad-hoc charge.", 400);
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new AdhocChargeError("Amount must be greater than zero.", 400);
  }

  const isPostpaid =
    !!caseData.aggregator_id && caseData.aggregator?.billing_method === "postpaid";

  // Same rule as computeCaseInvoice: postpaid always bills the aggregator
  // (bill_to is a prepaid-only field and is null there), prepaid honours
  // bill_to, direct bills the client.
  let billToAggregator =
    caseData.case_source === "aggregator" &&
    (isPostpaid || caseData.bill_to === "aggregator");

  if (input.billToOverride === "client") billToAggregator = false;

  if (caseData.case_source === "aggregator" && !isPostpaid && !caseData.bill_to
      && input.billToOverride !== "client") {
    throw new AdhocChargeError(
      "Bill-to (aggregator or client) must be selected on this prepaid case before raising a charge.",
      400,
    );
  }

  const endClientName = caseDisplayName(caseData);

  const buyerGstin = billToAggregator
    ? caseData.aggregator?.gst_number ?? null
    : caseData.client_gst_number ?? null;

  // Mirrors the precedent in case-invoicing: interstate only ever arises from
  // an aggregator outside Tamil Nadu; cases carry no state of their own.
  const isInterstate = billToAggregator
    ? !(caseData.aggregator?.same_state_as_twv ?? true)
    : false;

  const subtotal = Math.round(input.amount * 100) / 100;
  const gstRate = 18;
  const gstAmount = Math.round(subtotal * gstRate) / 100;

  return {
    billTo: billToAggregator ? "aggregator" : "client",
    buyerName: billToAggregator
      ? caseData.aggregator?.name ?? "(aggregator)"
      : endClientName,
    buyerGstin,
    endClientName,
    subtotal,
    gstRate,
    gstAmount,
    cgst: isInterstate ? 0 : gstAmount / 2,
    sgst: isInterstate ? 0 : gstAmount / 2,
    igst: isInterstate ? gstAmount : 0,
    total: subtotal + gstAmount,
    isInterstate,
    placeOfSupply: "Tamil Nadu",
  };
}

/**
 * Creates the vo_adhoc billing statement. Finalized immediately — an ad-hoc
 * charge is raised because it is already owed, so there is no draft stage to
 * sit in.
 */
export async function createAdhocCharge(
  supabase: SupabaseClient,
  caseData: AdhocChargeCase,
  input: AdhocChargeInput,
): Promise<{ statementId: string; preview: AdhocChargePreview }> {
  const preview = computeAdhocCharge(caseData, input);
  const today = new Date().toISOString().slice(0, 10);

  const { data: statement, error } = await supabase
    .from("billing_statements")
    .insert({
      case_id: caseData.id,
      period_start: today,
      period_end: today,
      statement_type: "vo_adhoc",
      created_via: "vo_adhoc_charge",
      fixed_amount: 0,
      usage_amount: preview.subtotal,
      subtotal: preview.subtotal,
      tax_percentage: preview.gstRate,
      tax_amount: preview.gstAmount,
      cgst_amount: preview.cgst,
      sgst_amount: preview.sgst,
      igst_amount: preview.igst,
      total_amount: preview.total,
      is_interstate: preview.isInterstate,
      place_of_supply: preview.placeOfSupply,
      buyer_gstin: preview.buyerGstin,
      status: "finalized",
      finalized_at: new Date().toISOString(),
      line_items: [
        {
          type: "adhoc",
          label: "Ad-hoc charge",
          subtotal: preview.subtotal,
          items: [
            {
              // Names the end client even when the aggregator is billed — a
              // partner holds many cases and the charge is ambiguous without it.
              description: `${input.description.trim()} — ${preview.endClientName}`,
              quantity: 1,
              rate: preview.subtotal,
              amount: preview.subtotal,
              notes: input.notes?.trim() || null,
            },
          ],
        },
      ],
    })
    .select("id")
    .single();

  if (error || !statement) {
    throw new AdhocChargeError(`Failed to raise the charge: ${error?.message}`, 500);
  }

  return { statementId: statement.id, preview };
}
