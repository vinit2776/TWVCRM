/**
 * Proposal revisions (pure logic).
 *
 * Once a proposal has been sent its terms are not edited in place. A revision
 * is a new proposal, PROP-0231 -> PROP-0231-R2, and the original becomes
 * `superseded`. Anything with money collected is locked outright.
 */

/** PROP-0231-R3 -> PROP-0231. Unrevised numbers come back unchanged. */
export function baseProposalNumber(proposalNumber: string): string {
  return proposalNumber.replace(/-R\d+$/, "");
}

/** The number a revision of `proposalNumber` gets. */
export function revisionProposalNumber(proposalNumber: string, currentRevisionNumber: number): string {
  return `${baseProposalNumber(proposalNumber)}-R${Math.max(1, currentRevisionNumber) + 1}`;
}

export interface RevisableProposal {
  status: string;
  deposit_payment_status?: string | null;
  payment_status?: string | null;
  deposit_credit_amount?: number | string | null;
}

/**
 * Why this proposal can't be revised, or null if it can.
 * Messages are shown to staff as-is.
 */
export function revisionBlockedReason(p: RevisableProposal): string | null {
  if (p.status === "superseded") return "This proposal has already been replaced by a newer revision.";
  if (p.status === "accepted") {
    return "The customer already accepted this proposal. Create a new proposal and get that accepted instead.";
  }
  if (p.status === "draft" || p.status === "rejected") {
    return "This proposal hasn't been sent (or was rejected), so it can be edited directly.";
  }
  if (p.status !== "sent" && p.status !== "viewed") {
    return `A ${p.status} proposal can't be revised.`;
  }
  if (p.deposit_payment_status === "paid" || p.payment_status === "paid" || Number(p.deposit_credit_amount ?? 0) > 0) {
    return "Money has already been collected (or credited) on this proposal, so its terms are locked. Talk to accounts before changing anything.";
  }
  return null;
}

export interface RevisionContent {
  items: { total: number }[];
  tax_percentage: number;
  discount_percentage: number;
  security_deposit_months?: number | null;
  security_deposit_amount?: number | null;
}

/** Totals and deposit state for a revision, computed the same way POST /api/proposals does. */
export function revisionTotals(c: RevisionContent) {
  const subtotal = c.items.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * (c.tax_percentage / 100);
  const discountAmount = subtotal * (c.discount_percentage / 100);
  const depositMonths = c.security_deposit_months || 0;
  return {
    subtotal,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    total_amount: subtotal + taxAmount - discountAmount,
    security_deposit_months: depositMonths,
    security_deposit_amount: c.security_deposit_amount ?? depositMonths * subtotal,
    deposit_payment_status: depositMonths > 0 ? "pending" : "not_required",
  };
}
