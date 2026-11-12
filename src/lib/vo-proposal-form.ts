/**
 * Virtual Office proposal creation form (pure logic).
 *
 * Validation and request-body building for the VO mode of the create-proposal dialog, kept apart
 * from the component so the rules are testable. The server re-checks everything in POST /api/proposals.
 */

import { VO_RATE_PURPOSE_LABELS, type VoRatePurpose } from "@/lib/constants";
import { isAllowedVoTerm, termFee } from "@/lib/vo-proposal";
import type { VoPricingResult } from "@/lib/vo-pricing";

export interface VoFormValues {
  title: string;
  purpose: VoRatePurpose | "";
  locationId: string | null;
  termMonths: number | null;
  /** Raw text of the quoted price input (a rate: the term fee up to 12 months, annual above). */
  quotedRate: string;
  belowFloorReason: string;
}

/** What the pricing preview said about the current purpose, location and term. */
export type VoPricingView =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "not_set_up" }
  | { state: "no_rate"; message: string }
  | { state: "ready"; pricing: Extract<VoPricingResult, { ok: true }> };

export function parseQuotedRate(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

/** True when the entered rate is below the card floor (needs a reason and manager approval). */
export function isBelowFloor(view: VoPricingView, quotedRate: number | null): boolean {
  if (view.state !== "ready" || quotedRate === null) return false;
  const floor = view.pricing.floor;
  return floor !== null && Math.round(quotedRate * 100) / 100 < floor;
}

/** First blocking problem with the form, or null when it can be submitted. */
export function validateVoForm(values: VoFormValues, view: VoPricingView): string | null {
  if (!values.title.trim()) return "Please enter a proposal title";
  if (!values.purpose) return "Choose the purpose (GST new or GST existing)";
  if (!values.locationId) return "Choose the location";
  if (values.termMonths === null || !isAllowedVoTerm(values.termMonths)) return "Choose a term (11, 12, 24, 36 or 48 months)";
  if (view.state === "loading") return "Wait for the rate card price to load";
  if (view.state === "no_rate") return view.message;
  const rate = parseQuotedRate(values.quotedRate);
  if (rate === null) return "Enter the quoted price";
  if (isBelowFloor(view, rate) && values.belowFloorReason.trim().length < 5) {
    return "This quote is below the floor. Say why, so a manager can approve it.";
  }
  return null;
}

/**
 * Body for POST /api/proposals with kind = virtual_office. The schema still wants a line item and
 * commitment terms, so the single line carries the whole-term fee and lock-in equals the term.
 * Deposit is zero by definition for this kind (the server forces it too).
 */
export function buildVoProposalBody(
  values: VoFormValues & { purpose: VoRatePurpose; termMonths: number },
  leadId: string,
  below: boolean,
) {
  const rate = parseQuotedRate(values.quotedRate) as number;
  const fee = termFee(rate, values.termMonths);
  const purposeLabel = VO_RATE_PURPOSE_LABELS[values.purpose] ?? values.purpose;
  return {
    kind: "virtual_office" as const,
    lead_id: leadId,
    location_id: values.locationId || undefined,
    title: values.title.trim(),
    items: [
      {
        description: `Virtual Office (${purposeLabel}), ${values.termMonths} months`,
        quantity: 1,
        unit_price: fee,
        total: fee,
        escalates: false,
      },
    ],
    tax_percentage: 18,
    discount_percentage: 0,
    security_deposit_months: 0,
    security_deposit_amount: 0,
    tenure_months: values.termMonths,
    lock_in_months: values.termMonths,
    notice_period_months: 0,
    vo_purpose: values.purpose,
    vo_term_months: values.termMonths,
    vo_quoted_price: rate,
    ...(below ? { vo_below_floor_reason: values.belowFloorReason.trim() } : {}),
  };
}
