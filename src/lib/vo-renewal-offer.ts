/**
 * What a Virtual Office renewal costs and covers, as offered by Start renewal.
 *
 * Pure so the dialog's live figures and the route that bills them come from
 * the same arithmetic. The case's `rate` is the fee for its whole term
 * (`tenure_months`), so a renewal for a different length is priced pro rata
 * from that before escalation is applied.
 */
import { nextRenewalTerm, type RenewalTerm } from "@/lib/vo-renewal-term";

export const RENEWAL_DURATIONS = [6, 12, 24, 36] as const;
export type RenewalDuration = (typeof RENEWAL_DURATIONS)[number];

export const RENEWAL_ESCALATION_MODES = ["agreed", "none", "custom"] as const;
export type RenewalEscalationMode = (typeof RENEWAL_ESCALATION_MODES)[number];

export const RENEWAL_ESCALATION_MODE_LABELS: Record<RenewalEscalationMode, string> = {
  agreed: "As agreed",
  none: "No escalation",
  custom: "Custom",
};

/** Matches createRenewalBillingStatement and the PI. */
export const RENEWAL_GST_PERCENT = 18;

export interface RenewalOfferInput {
  /** cases.rate — the fee for the current full term. */
  currentFee: number;
  currentTenureMonths: number | null | undefined;
  /** cases.renewal_escalation_percentage. */
  agreedEscalationPercentage: number | null | undefined;
  currentEnd: string;
  durationMonths: number;
  mode: RenewalEscalationMode;
  customPercentage?: number | null;
}

export interface RenewalOffer {
  term: RenewalTerm;
  durationMonths: number;
  /** Current fee scaled to the new term's length, before escalation. */
  baseFee: number;
  escalationPercentage: number;
  /** Fee for the whole new term, before GST. Becomes the case's rate once paid. */
  fee: number;
  gst: number;
  total: number;
}

export function escalationFor(
  mode: RenewalEscalationMode,
  agreed: number | null | undefined,
  custom: number | null | undefined,
): number {
  if (mode === "none") return 0;
  if (mode === "agreed") return agreed && agreed > 0 ? agreed : 0;
  return custom && custom > 0 ? custom : 0;
}

export function renewalOffer(input: RenewalOfferInput): RenewalOffer {
  const tenure =
    input.currentTenureMonths && input.currentTenureMonths > 0 ? input.currentTenureMonths : 12;
  const baseFee = Math.round((input.currentFee * input.durationMonths) / tenure);
  const escalationPercentage = escalationFor(
    input.mode,
    input.agreedEscalationPercentage,
    input.customPercentage,
  );
  // Whole rupees, as renewalRate() does — part-rupee fees read as errors.
  const fee = Math.round(baseFee * (1 + escalationPercentage / 100));
  const gst = Math.round(fee * RENEWAL_GST_PERCENT) / 100;
  return {
    term: nextRenewalTerm(input.currentEnd, input.durationMonths),
    durationMonths: input.durationMonths,
    baseFee,
    escalationPercentage,
    fee,
    gst,
    total: fee + gst,
  };
}
