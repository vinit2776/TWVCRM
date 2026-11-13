/**
 * Virtual Office direct proposals (pure logic).
 *
 * A VO proposal is a row in `proposals` with kind = 'virtual_office'. Standard
 * proposals never pass through this file: every rule here is keyed off `kind`
 * so they keep behaving exactly as before.
 */

import { z } from "zod";

export const PROPOSAL_KINDS = ["standard", "virtual_office"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const VO_PROPOSAL_VALIDITY_DAYS = 7;
export const VO_ALLOWED_TERMS = [11, 12, 24, 36, 48] as const;
export const VO_PROPOSAL_EXPIRY_CRON_MODE_SETTING = "vo_proposal_expiry_cron_mode";

export const isVoProposal = (p: { kind?: string | null }): boolean => p.kind === "virtual_office";

export function isAllowedVoTerm(months: number): boolean {
  return (VO_ALLOWED_TERMS as readonly number[]).includes(months);
}

/** Zod-free validation for staff input; returns a message or null. */
export function validateVoTerm(months: unknown): string | null {
  if (typeof months !== "number" || !Number.isInteger(months) || !isAllowedVoTerm(months)) {
    return `A Virtual Office term must be one of ${VO_ALLOWED_TERMS.join(", ")} months.`;
  }
  return null;
}

/**
 * Fee for the whole term. Up to 12 months the rate IS the term fee; above 12
 * months the rate is the ANNUAL rate (owner-confirmed, 11 Nov 2026).
 */
export function termFee(rate: number, tenureMonths: number): number {
  const fee = tenureMonths > 12 ? (rate * tenureMonths) / 12 : rate;
  return Math.round(fee * 100) / 100;
}

/** Extra body fields POST /api/proposals reads when kind = virtual_office. */
export const voCreateSchema = z.object({
  vo_term_months: z.number().int().refine(isAllowedVoTerm, { message: `A Virtual Office term must be one of ${VO_ALLOWED_TERMS.join(", ")} months.` }),
  vo_quoted_price: z.number().positive("Quoted price is required"),
  vo_guide_price: z.number().nonnegative().optional(),
});

// ---- Status transitions ------------------------------------------------------

export const VO_PROPOSAL_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["sent"],
  sent: ["viewed", "accepted", "changes_requested", "declined", "withdrawn", "expired", "superseded"],
  viewed: ["accepted", "changes_requested", "declined", "withdrawn", "expired", "superseded"],
  changes_requested: ["withdrawn", "expired", "superseded"],
  // A dead proposal can still be replaced by a reissued version.
  withdrawn: ["superseded"],
  declined: ["superseded"],
  expired: ["superseded"],
  accepted: [],
  rejected: [],
  superseded: [],
};

export function canVoTransition(from: string, to: string): boolean {
  return (VO_PROPOSAL_TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses the customer can still respond to. */
export const VO_CUSTOMER_RESPONDABLE = ["sent", "viewed"] as const;
/** Statuses staff may withdraw from. */
export const VO_WITHDRAWABLE = ["sent", "viewed", "changes_requested"] as const;
/** Statuses staff may reissue from (the old version becomes superseded). */
export const VO_REISSUABLE = ["sent", "viewed", "changes_requested", "withdrawn", "declined", "expired"] as const;

export type CustomerAction = "accept" | "request_changes" | "decline";

export const CUSTOMER_ACTION_STATUS: Record<CustomerAction, string> = {
  accept: "accepted",
  request_changes: "changes_requested",
  decline: "declined",
};

// ---- Expiry --------------------------------------------------------------------

export function voExpiryFrom(sentAt: Date | string): Date {
  const d = new Date(sentAt);
  return new Date(d.getTime() + VO_PROPOSAL_VALIDITY_DAYS * 24 * 3600 * 1000);
}

/**
 * When a VO proposal lapses: its stored expires_at, else 7 days after it was
 * sent (so rows sent before expires_at was written still lapse). Null for a
 * proposal that has not been sent, and for any non-VO proposal, whose
 * valid_until stays advisory exactly as today.
 */
export function effectiveExpiry(p: {
  kind?: string | null;
  expires_at?: string | null;
  sent_at?: string | null;
}): Date | null {
  if (!isVoProposal(p)) return null;
  if (p.expires_at) return new Date(p.expires_at);
  return p.sent_at ? voExpiryFrom(p.sent_at) : null;
}

export function isVoProposalExpired(
  p: { kind?: string | null; expires_at?: string | null; sent_at?: string | null },
  now: Date = new Date(),
): boolean {
  const e = effectiveExpiry(p);
  return !!e && e.getTime() <= now.getTime();
}

// ---- Customer response and staff actions ---------------------------------------

/** Why the customer cannot respond right now, or null if they can. */
export function customerResponseBlockedReason(
  p: { kind?: string | null; status: string; expires_at?: string | null; sent_at?: string | null },
  now: Date = new Date(),
): string | null {
  if (!isVoProposal(p)) return "This proposal cannot be answered online.";
  if (p.status === "superseded") return "This proposal has been replaced by a newer version. Please use the latest link we sent you.";
  if (p.status === "withdrawn") return "This proposal has been withdrawn. Please contact us.";
  if (p.status === "expired" || (["sent", "viewed"].includes(p.status) && isVoProposalExpired(p, now))) {
    return "This proposal has expired. Please contact us for a fresh one.";
  }
  if (!(VO_CUSTOMER_RESPONDABLE as readonly string[]).includes(p.status)) {
    return p.status === "accepted" ? "This proposal has already been accepted." : "This proposal has already been answered.";
  }
  return null;
}

export interface VoPaymentFacts {
  deposit_payment_status?: string | null;
  payment_status?: string | null;
  deposit_credit_amount?: number | string | null;
}

function moneyCollected(p: VoPaymentFacts): boolean {
  return p.deposit_payment_status === "paid" || p.payment_status === "paid" || Number(p.deposit_credit_amount ?? 0) > 0;
}

export function voWithdrawBlockedReason(p: { kind?: string | null; status: string } & VoPaymentFacts): string | null {
  if (!isVoProposal(p)) return "Only Virtual Office proposals can be withdrawn here.";
  if (!(VO_WITHDRAWABLE as readonly string[]).includes(p.status)) return `A ${p.status.replace("_", " ")} proposal cannot be withdrawn.`;
  if (moneyCollected(p)) return "Money has already been collected on this proposal. Talk to accounts first.";
  return null;
}

export function voReissueBlockedReason(p: { kind?: string | null; status: string } & VoPaymentFacts): string | null {
  if (!isVoProposal(p)) return "Only Virtual Office proposals can be reissued here. Use Revise for other proposals.";
  if (p.status === "accepted") return "The customer already accepted this proposal.";
  if (p.status === "superseded") return "This proposal has already been replaced by a newer version.";
  if (!(VO_REISSUABLE as readonly string[]).includes(p.status)) return `A ${p.status.replace("_", " ")} proposal cannot be reissued.`;
  if (moneyCollected(p)) return "Money has already been collected on this proposal. Talk to accounts first.";
  return null;
}
