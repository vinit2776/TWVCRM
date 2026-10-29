/**
 * Walk-away refund of a deposit collected in parts (migration 00650). Refund
 * only — nothing is retained. Mirrors the exit-settlement flow: a manager or
 * sales rep requests it, an ADMIN approves every refund whatever the amount,
 * accounts pays it as a bank transfer, and paying closes the proposal as
 * "Customer withdrew".
 */

export const DEPOSIT_REFUND_REQUEST_ROLES = ["admin", "manager", "sales_rep"] as const;
export const DEPOSIT_REFUND_APPROVE_ROLES = ["admin"] as const;
export const DEPOSIT_REFUND_PAY_ROLES = ["admin", "accounts"] as const;

export type DepositRefundStatus = "pending_approval" | "approved" | "rejected" | "paid";

export const DEPOSIT_REFUND_STATUS_LABELS: Record<DepositRefundStatus, string> = {
  pending_approval: "Awaiting admin approval",
  approved: "Approved, to pay",
  rejected: "Not approved",
  paid: "Refunded",
};

export const DEPOSIT_REFUND_STATUS_COLORS: Record<DepositRefundStatus, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-blue-100 text-blue-800",
  rejected: "bg-red-100 text-red-700",
  paid: "bg-green-100 text-green-800",
};

export function canRequestDepositRefund(role: string | null | undefined): boolean {
  return !!role && (DEPOSIT_REFUND_REQUEST_ROLES as readonly string[]).includes(role);
}

/** Plain-language text for the codes the refund functions return. */
export function depositRefundErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not_allowed": return "You do not have permission to do that.";
    case "admin_only": return "Only an admin can approve or reject a refund.";
    case "reason_required": return "Give a reason (at least 10 characters).";
    case "reference_required": return "Enter the bank UTR or reference.";
    case "proposal_not_found": return "Proposal not found.";
    case "deposit_complete": return "The deposit is fully paid. A refund from here is only for a deposit still partly paid — use the contract exit flow instead.";
    case "contract_exists": return "A contract exists for this proposal. Use the contract exit flow for its deposit.";
    case "open_ask_exists": return "There is an unpaid part request. Cancel it first.";
    case "refund_exists": return "A refund is already in progress for this proposal.";
    case "nothing_to_refund": return "No part of the deposit has been paid, so there is nothing to refund.";
    case "refund_not_found": return "Refund not found.";
    case "not_pending": return "This refund is no longer awaiting approval.";
    case "not_approved": return "Only an approved refund can be marked paid.";
    default: return "Could not complete the refund step.";
  }
}
