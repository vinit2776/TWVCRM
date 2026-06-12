import { computeGstAndRounding, type GstResult } from "@/lib/gst-math";

export type ElectricityMarkupType = "per_unit" | "percent";
export type ElectricityLineType = "utility" | "generator" | "other";

export interface ElectricityComputeConfig {
  reimbursement_enabled: boolean;
  customer_markup_type: ElectricityMarkupType;
  customer_markup_per_unit: number;
  customer_markup_percent: number;
  landlord_gst_rate: number;
  landlord_tds_rate: number;
}

export interface ElectricityComputeLine {
  line_type: ElectricityLineType;
  units: number;
  landlord_rate: number;
}

export interface ElectricityComputedLine {
  line_type: ElectricityLineType;
  units: number;
  landlord_rate: number;
  landlord_amount: number;
  customer_rate: number;
  customer_amount: number;
}

export interface ElectricityBillResult {
  lines: ElectricityComputedLine[];
  landlord_subtotal: number;
  landlord_gst: number;
  landlord_tds: number;
  /** subtotal + gst − tds */
  landlord_net_payable: number;
  customer_subtotal: number;
  customer_gst: GstResult;
  /** = customer_gst.totalAmount (rounded to nearest rupee, includes roundOff) */
  customer_total: number;
}

/**
 * Derive per-unit customer rate from landlord rate + config markup.
 * Exported for unit testing and per-line preview in the capture UI.
 */
export function computeCustomerRate(
  config: Pick<
    ElectricityComputeConfig,
    "customer_markup_type" | "customer_markup_per_unit" | "customer_markup_percent"
  >,
  landlordRate: number,
): number {
  if (config.customer_markup_type === "per_unit") {
    return landlordRate + config.customer_markup_per_unit;
  }
  return landlordRate * (1 + config.customer_markup_percent / 100);
}

/**
 * Compute full electricity bill — landlord vendor bill side + customer statement side.
 *
 * All intermediate arithmetic uses integer paise to eliminate float drift.
 * Customer GST is always 18% intra-state via computeGstAndRounding.
 * Landlord GST/TDS rates come from config (per-location negotiated rates).
 */
export function computeElectricityBill(
  config: ElectricityComputeConfig,
  rawLines: ElectricityComputeLine[],
): ElectricityBillResult {
  const lines: ElectricityComputedLine[] = rawLines.map((l) => {
    const landlordAmountPaise = Math.round(l.units * l.landlord_rate * 100);
    const customerRate = computeCustomerRate(config, l.landlord_rate);
    const customerAmountPaise = config.reimbursement_enabled
      ? Math.round(l.units * customerRate * 100)
      : 0;
    return {
      line_type: l.line_type,
      units: l.units,
      landlord_rate: l.landlord_rate,
      landlord_amount: landlordAmountPaise / 100,
      customer_rate: customerRate,
      customer_amount: customerAmountPaise / 100,
    };
  });

  const landlordSubtotalPaise = lines.reduce(
    (s, l) => s + Math.round(l.landlord_amount * 100),
    0,
  );
  const landlordGstPaise = Math.round(
    (landlordSubtotalPaise * config.landlord_gst_rate) / 100,
  );
  const landlordTdsPaise = Math.round(
    (landlordSubtotalPaise * config.landlord_tds_rate) / 100,
  );

  const customerSubtotalPaise = lines.reduce(
    (s, l) => s + Math.round(l.customer_amount * 100),
    0,
  );
  const customerGst = computeGstAndRounding(customerSubtotalPaise / 100, 18);

  return {
    lines,
    landlord_subtotal: landlordSubtotalPaise / 100,
    landlord_gst: landlordGstPaise / 100,
    landlord_tds: landlordTdsPaise / 100,
    landlord_net_payable:
      (landlordSubtotalPaise + landlordGstPaise - landlordTdsPaise) / 100,
    customer_subtotal: customerSubtotalPaise / 100,
    customer_gst: customerGst,
    customer_total: customerGst.totalAmount,
  };
}
