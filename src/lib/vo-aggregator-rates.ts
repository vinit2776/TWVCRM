import { VO_RATE_PURPOSES } from "@/lib/constants";
import { lookupDirectRate, type RateMatch } from "@/lib/vo-rates";

export const VO_GST_PERCENT = 18;

export interface AggregatorRateRow {
  id?: string;
  aggregator_id?: string;
  purpose: string;
  location_id: string | null;
  pricing_type: "open" | "fixed";
  share_percent: number | null;
  min_customer_price: number | null;
  fixed_rate: number | null;
  version?: number;
}

export type AggregatorRateInput = Omit<AggregatorRateRow, "id" | "aggregator_id" | "version">;

/** Exact location first, then Any location; same lookup rule as the direct card. */
export function lookupAggregatorRate<T extends Pick<AggregatorRateRow, "purpose" | "location_id">>(
  rows: T[],
  purpose: string,
  locationId: string | null,
): RateMatch<T> | null {
  return lookupDirectRate(rows, purpose, locationId);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AggregatorInvoice {
  customerPriceExGst: number;
  /** What we invoice the aggregator, before GST. */
  ours: number;
  /** What the aggregator keeps of the customer's price. */
  retained: number;
  gst: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  belowMinimum: boolean;
}

/**
 * Same GST split as aggregator-invoicing.ts: CGST and SGST half each when the aggregator
 * is in TWV's state, otherwise all IGST. The minimum customer price is compared with the
 * customer price excluding GST.
 */
export function computeAggregatorInvoice(input: {
  row: AggregatorRateRow;
  customerPrice: number;
  priceIncludesGst: boolean;
  sameStateAsTwv: boolean;
}): AggregatorInvoice {
  const { row, customerPrice, priceIncludesGst, sameStateAsTwv } = input;
  const exGst = r2(priceIncludesGst ? customerPrice / (1 + VO_GST_PERCENT / 100) : customerPrice);
  const ours = row.pricing_type === "fixed" ? r2(row.fixed_rate ?? 0) : r2((exGst * (row.share_percent ?? 0)) / 100);
  const gst = r2((ours * VO_GST_PERCENT) / 100);
  const half = r2(gst / 2);
  return {
    customerPriceExGst: exGst,
    ours,
    retained: r2(exGst - ours),
    gst,
    cgst: sameStateAsTwv ? half : 0,
    sgst: sameStateAsTwv ? half : 0,
    igst: sameStateAsTwv ? 0 : gst,
    total: r2(ours + gst),
    belowMinimum: row.pricing_type === "open" && row.min_customer_price !== null && exGst < row.min_customer_price,
  };
}

/** Copies another aggregator's card as fresh version 1 rows starting on a new date. */
export function copyCardRows<T extends AggregatorRateRow>(
  rows: T[],
  opts: { effectiveFrom: string },
): Array<AggregatorRateInput & { version: 1; effective_from: string }> {
  return rows.map((r) => ({
    purpose: r.purpose,
    location_id: r.location_id,
    pricing_type: r.pricing_type,
    share_percent: r.share_percent,
    min_customer_price: r.min_customer_price,
    fixed_rate: r.fixed_rate,
    version: 1 as const,
    effective_from: opts.effectiveFrom,
  }));
}

/** Returns a list of problems with a row; empty means valid. */
export function validateRowInput(input: AggregatorRateInput): string[] {
  const errors: string[] = [];
  if (!(VO_RATE_PURPOSES as readonly string[]).includes(input.purpose)) errors.push("Unknown purpose");
  if (input.pricing_type === "open") {
    const s = input.share_percent;
    if (s === null || s === undefined) errors.push("Share percent is required for open pricing");
    else if (s < 1 || s > 99) errors.push("Share percent must be between 1 and 99");
    if (input.fixed_rate !== null) errors.push("Fixed rate must be empty for open pricing");
    if (input.min_customer_price !== null && input.min_customer_price < 0) errors.push("Minimum customer price cannot be negative");
  } else if (input.pricing_type === "fixed") {
    if (input.fixed_rate === null || input.fixed_rate === undefined) errors.push("Fixed rate is required for fixed pricing");
    else if (input.fixed_rate < 0) errors.push("Fixed rate cannot be negative");
    if (input.share_percent !== null) errors.push("Share percent must be empty for fixed pricing");
    if (input.min_customer_price !== null) errors.push("Minimum customer price applies to open pricing only");
  } else {
    errors.push("Unknown pricing type");
  }
  return errors;
}
