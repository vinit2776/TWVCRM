import { computeGstAndRounding, type GstResult } from "@/lib/gst-math";

export type ElectricityMarkupType = "per_unit" | "percent";
export type ElectricityLineType = "utility" | "generator" | "other";

export interface ElectricityComputeConfig {
  reimbursement_enabled: boolean;
  /** % of the landlord's TOTAL captured units (utility + generator combined) billed to the customer as "utility". */
  customer_utility_pct: number;
  /** % of the landlord's TOTAL captured units billed to the customer as "generator"/DG. */
  customer_generator_pct: number;
  utility_markup_type: ElectricityMarkupType;
  utility_markup_value: number;
  generator_markup_type: ElectricityMarkupType;
  generator_markup_value: number;
  landlord_gst_rate: number;
  landlord_tds_rate: number;
  /** GST rate on the customer invoice — defaults to 18 (intra-state) when omitted. */
  customer_gst_rate?: number;
}

export interface ElectricityComputeLine {
  line_type: "utility" | "generator";
  units: number;
  landlord_rate: number;
}

export interface ElectricityBillResult {
  landlord_subtotal: number;
  landlord_gst: number;
  landlord_tds: number;
  /** subtotal + gst − tds */
  landlord_net_payable: number;
  /** Customer-side units after re-splitting the landlord's TOTAL units by customer_utility_pct/customer_generator_pct */
  customer_utility_units: number;
  customer_generator_units: number;
  /** Derived as this bill's effective (weighted-avg) landlord rate + markup */
  customer_utility_rate: number;
  customer_generator_rate: number;
  customer_subtotal: number;
  customer_gst: GstResult;
  /** = customer_gst.totalAmount (rounded to nearest rupee, includes roundOff) */
  customer_total: number;
}

/**
 * Derive a per-unit customer rate from a landlord rate + markup.
 * Exported for unit testing and per-line preview in the capture UI.
 */
export function computeCustomerRate(
  markup: { markup_type: ElectricityMarkupType; markup_value: number },
  landlordRate: number,
): number {
  if (markup.markup_type === "per_unit") {
    return landlordRate + markup.markup_value;
  }
  return landlordRate * (1 + markup.markup_value / 100);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute full electricity bill — landlord vendor bill side + customer statement side.
 *
 * The customer ratio (customer_utility_pct/customer_generator_pct) applies to the
 * landlord's COMBINED total units, not to each meter's sub-total independently — the
 * customer-side split is intentionally allowed to differ from the landlord's own
 * utility/generator split. Customer rates are derived per line type as this bill's
 * effective (weighted-average, in case of multiple meters) landlord rate + markup,
 * matching the approve_electricity_landlord_bill RPC (see 00322 migration).
 *
 * All intermediate arithmetic uses integer paise to eliminate float drift.
 * Customer GST defaults to 18% intra-state via computeGstAndRounding, overridable
 * per config.customer_gst_rate (e.g. a billing profile's own rate).
 * Landlord GST/TDS rates come from config (per-location negotiated rates).
 */
export function computeElectricityBill(
  config: ElectricityComputeConfig,
  rawLines: ElectricityComputeLine[],
): ElectricityBillResult {
  const totalsFor = (type: "utility" | "generator") => {
    const matching = rawLines.filter((l) => l.line_type === type);
    const unitsPaise = matching.reduce((s, l) => s + Math.round(l.units * 100), 0);
    const amountPaise = matching.reduce((s, l) => s + Math.round(l.units * l.landlord_rate * 100), 0);
    return { units: unitsPaise / 100, amount: amountPaise / 100 };
  };

  const utility = totalsFor("utility");
  const generator = totalsFor("generator");

  const landlordSubtotalPaise = Math.round(utility.amount * 100) + Math.round(generator.amount * 100);
  const landlordGstPaise = Math.round((landlordSubtotalPaise * config.landlord_gst_rate) / 100);
  const landlordTdsPaise = Math.round((landlordSubtotalPaise * config.landlord_tds_rate) / 100);

  const totalUnits = utility.units + generator.units;
  const effUtilityRate = utility.units > 0 ? utility.amount / utility.units : 0;
  const effGeneratorRate = generator.units > 0 ? generator.amount / generator.units : 0;

  const customerUtilityUnits = round2((totalUnits * config.customer_utility_pct) / 100);
  const customerGeneratorUnits = round2((totalUnits * config.customer_generator_pct) / 100);

  const customerUtilityRate = computeCustomerRate(
    { markup_type: config.utility_markup_type, markup_value: config.utility_markup_value },
    effUtilityRate,
  );
  const customerGeneratorRate = computeCustomerRate(
    { markup_type: config.generator_markup_type, markup_value: config.generator_markup_value },
    effGeneratorRate,
  );

  const customerSubtotalPaise = config.reimbursement_enabled
    ? Math.round(customerUtilityUnits * customerUtilityRate * 100) +
      Math.round(customerGeneratorUnits * customerGeneratorRate * 100)
    : 0;

  const customerGst = computeGstAndRounding(customerSubtotalPaise / 100, config.customer_gst_rate ?? 18);

  return {
    landlord_subtotal: landlordSubtotalPaise / 100,
    landlord_gst: landlordGstPaise / 100,
    landlord_tds: landlordTdsPaise / 100,
    landlord_net_payable: (landlordSubtotalPaise + landlordGstPaise - landlordTdsPaise) / 100,
    customer_utility_units: customerUtilityUnits,
    customer_generator_units: customerGeneratorUnits,
    customer_utility_rate: customerUtilityRate,
    customer_generator_rate: customerGeneratorRate,
    customer_subtotal: customerSubtotalPaise / 100,
    customer_gst: customerGst,
    customer_total: customerGst.totalAmount,
  };
}
