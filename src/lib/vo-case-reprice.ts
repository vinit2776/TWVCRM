/**
 * Re-pricing a Virtual Office case against the current rate card (pure logic).
 * Only while the case is still being prepared: once it is invoiced, or the agreement has gone to the
 * customer, the price is part of something already issued.
 */

export const VO_CASE_REPRICEABLE_STATUSES = ["intake_received", "docs_received", "internal_approved"] as const;

const AGREEMENT_ISSUED = ["sent_to_client", "client_approved", "signing", "executed"];

export function voCaseRepriceBlockedReason(c: {
  status: string;
  hasLiveInvoice: boolean;
  agreementStatuses: string[];
  cardPurpose: string | null;
}): string | null {
  if (!c.cardPurpose) return "This case's purpose has no rate card, so there is nothing to re-price against.";
  if (!(VO_CASE_REPRICEABLE_STATUSES as readonly string[]).includes(c.status)) {
    return `A case that is ${c.status.replace(/_/g, " ")} cannot be re-priced.`;
  }
  if (c.hasLiveInvoice) return "An invoice already exists for this case. Void it before re-pricing.";
  if (c.agreementStatuses.some((s) => AGREEMENT_ISSUED.includes(s))) {
    return "The agreement has already gone to the customer, so the price is fixed.";
  }
  return null;
}
