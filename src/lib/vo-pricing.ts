/**
 * Virtual Office pricing guidance (pure logic).
 *
 * Wires the rate cards (vo-rates.ts, vo-aggregator-rates.ts) into quoting. Rules (owner, 11 Nov 2026):
 *  - Up to 12 months the rate is the fee for that term; for 24/36/48 it is the ANNUAL rate and the
 *    term fee is rate x months / 12 (termFee in vo-proposal.ts). So D6 holds: the multi-year guide
 *    price is years x the yearly guide, paid up front.
 *  - Guides are guidance, never a cap. Only a quote BELOW the floor needs manager/admin approval.
 */

import type { VoRatePurpose } from "@/lib/constants";
import { VO_RATE_PURPOSE_LABELS } from "@/lib/constants";
import { termFee } from "@/lib/vo-proposal";
import { lookupDirectRate, suggestedAsk, type DirectRateRow, type Trend } from "@/lib/vo-rates";
import { computeAggregatorInvoice, lookupAggregatorRate, type AggregatorRateRow } from "@/lib/vo-aggregator-rates";

export type PriceClass = "below_floor" | "between" | "at_or_above_guide";

export const PRICE_CLASS_LABELS: Record<PriceClass, string> = {
  below_floor: "Below floor",
  between: "Between floor and guide",
  at_or_above_guide: "At or above guide",
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Rate-card purpose for a case/proposal purpose, or null when no card applies to it. */
export function rateCardPurposeFor(purpose: string | null | undefined): VoRatePurpose | null {
  if (purpose === "gst_new" || purpose === "gst_existing") return purpose;
  if (purpose === "gst_registration") return "gst_new";
  return null;
}

/** Compare a quoted RATE (same unit as the card: term fee up to 12 months, annual above) with the card. */
export function classifyRate(card: { guide_fee: number; floor_fee: number | null }, rate: number): PriceClass {
  const q = r2(rate);
  if (card.floor_fee !== null && q < Number(card.floor_fee)) return "below_floor";
  if (q >= Number(card.guide_fee)) return "at_or_above_guide";
  return "between";
}

export interface VoPricingInput {
  purpose: string;
  locationId: string | null;
  termMonths: number;
  rows: DirectRateRow[];
  trend?: Trend | null;
  quotedRate?: number | null;
}

export interface VoQuoteAssessment {
  rate: number;
  termFee: number;
  classification: PriceClass;
  requiresApproval: boolean;
}

export type VoPricingResult =
  | { ok: false; message: string }
  | {
      ok: true;
      card: { id: string | null; version: number | null; how: "exact" | "any"; purpose: string; locationId: string | null };
      termMonths: number;
      /** Card values, in rate units. */
      guide: number;
      floor: number | null;
      /** Whole-term amounts (guide x years for multi-year, D6). */
      termGuide: number;
      termFloor: number | null;
      trend: Trend | null;
      suggestedAsk: number;
      quote: VoQuoteAssessment | null;
    };

export function missingRateMessage(purpose: string, locationName?: string | null): string {
  const what = VO_RATE_PURPOSE_LABELS[purpose] ?? purpose;
  return `No rate card exists for ${what} at ${locationName || "this location"} or for Any location. Ask an admin or manager to add one in the Virtual Office rates page before quoting.`;
}

export function computeVoPricing(input: VoPricingInput): VoPricingResult {
  const match = lookupDirectRate(input.rows, input.purpose, input.locationId);
  if (!match) return { ok: false, message: missingRateMessage(input.purpose) };
  const row = match.row;
  const guide = Number(row.guide_fee);
  const floor = row.floor_fee === null || row.floor_fee === undefined ? null : Number(row.floor_fee);
  const trend = input.trend ?? null;

  let quote: VoQuoteAssessment | null = null;
  if (input.quotedRate !== null && input.quotedRate !== undefined && Number.isFinite(input.quotedRate)) {
    const classification = classifyRate({ guide_fee: guide, floor_fee: floor }, input.quotedRate);
    quote = {
      rate: r2(input.quotedRate),
      termFee: termFee(input.quotedRate, input.termMonths),
      classification,
      requiresApproval: classification === "below_floor",
    };
  }

  return {
    ok: true,
    card: { id: row.id ?? null, version: row.version ?? null, how: match.how, purpose: input.purpose, locationId: row.location_id },
    termMonths: input.termMonths,
    guide,
    floor,
    termGuide: termFee(guide, input.termMonths),
    termFloor: floor === null ? null : termFee(floor, input.termMonths),
    trend,
    suggestedAsk: suggestedAsk({ guide, avgWon: trend?.avgWon ?? null, winRate: trend?.winRate ?? null }),
    quote,
  };
}

/** Frozen onto a proposal or case so later card edits never change it. */
export function buildDirectSnapshot(result: Extract<VoPricingResult, { ok: true }>, capturedAt: Date = new Date()) {
  return {
    version: 1,
    source: "direct" as const,
    purpose: result.card.purpose,
    location_id: result.card.locationId,
    card_id: result.card.id,
    card_version: result.card.version,
    card_match: result.card.how,
    term_months: result.termMonths,
    guide_rate: result.guide,
    floor_rate: result.floor,
    term_guide: result.termGuide,
    term_floor: result.termFloor,
    quoted_rate: result.quote?.rate ?? null,
    quoted_term_fee: result.quote?.termFee ?? null,
    classification: result.quote?.classification ?? null,
    requires_approval: result.quote?.requiresApproval ?? false,
    captured_at: capturedAt.toISOString(),
  };
}

export type AggregatorPricingResult =
  | { ok: false; message: string }
  | { ok: true; snapshot: ReturnType<typeof buildAggregatorSnapshot> };

/**
 * Aggregator-sourced case: the aggregator's own card (open share or fixed price), exact location
 * then Any. Only snapshots; it does not change what the postpaid invoicing bills.
 */
export function computeAggregatorCasePricing(input: {
  purpose: string;
  locationId: string | null;
  termMonths: number;
  customerRate: number | null;
  rows: AggregatorRateRow[];
  capturedAt?: Date;
}): AggregatorPricingResult {
  const match = lookupAggregatorRate(input.rows, input.purpose, input.locationId);
  if (!match) {
    return { ok: false, message: `${missingRateMessage(input.purpose)} This aggregator has its own rate card, so the case cannot be created without a matching row.` };
  }
  return { ok: true, snapshot: buildAggregatorSnapshot(match.row, match.how, input) };
}

function buildAggregatorSnapshot(
  row: AggregatorRateRow,
  how: "exact" | "any",
  input: { purpose: string; termMonths: number; customerRate: number | null; capturedAt?: Date },
) {
  const customer = input.customerRate;
  const invoice =
    customer !== null
      ? computeAggregatorInvoice({ row, customerPrice: customer, priceIncludesGst: false, sameStateAsTwv: true })
      : null;
  return {
    version: 1,
    source: "aggregator" as const,
    purpose: input.purpose,
    location_id: row.location_id,
    card_id: row.id ?? null,
    card_version: row.version ?? null,
    card_match: how,
    term_months: input.termMonths,
    pricing_type: row.pricing_type,
    share_percent: row.share_percent,
    min_customer_price: row.min_customer_price,
    fixed_rate: row.fixed_rate,
    customer_rate: customer,
    our_amount: invoice?.ours ?? null,
    below_minimum: invoice?.belowMinimum ?? false,
    captured_at: (input.capturedAt ?? new Date()).toISOString(),
  };
}

/**
 * The price on the proposal must still be the price that was rate-card checked. The approval is keyed to the
 * stored quoted rate, so a later edit of the line items would otherwise go out under an approval for a different
 * (or no longer below-floor) price. Fails closed: re-create the quote instead of editing its price.
 */
export function voPriceChangedReason(proposal: {
  vo_price_snapshot?: { quoted_term_fee?: number | null } | null;
  subtotal?: number | string | null;
  discount_percentage?: number | string | null;
}): string | null {
  const snap = proposal.vo_price_snapshot;
  if (!snap || snap.quoted_term_fee == null || proposal.subtotal == null) return null;
  const priceMoved = Math.abs(Number(proposal.subtotal) - Number(snap.quoted_term_fee)) >= 0.5;
  const discounted = Number(proposal.discount_percentage ?? 0) > 0;
  if (priceMoved || discounted) return "The price was changed after it was checked against the rate card. Create a new Virtual Office proposal at the price you want.";
  return null;
}
