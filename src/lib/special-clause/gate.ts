// Pure rules for the special-clause approval gate. No I/O, so the API routes,
// the contract page and the unit tests all share one definition.

export type SpecialClauseStatus = "pending_approval" | "changes_requested" | "approved";

export const SPECIAL_CLAUSE_APPROVER_ROLES = ["admin", "manager"] as const;
export const SPECIAL_CLAUSE_AUTHOR_ROLES = ["admin", "manager", "sales_rep"] as const;

export const SPECIAL_CLAUSE_LABELS: Record<SpecialClauseStatus, string> = {
  pending_approval: "Clause awaiting approval",
  changes_requested: "Clause: changes requested",
  approved: "Clause approved",
};

export function canApproveSpecialClause(role: string | null | undefined): boolean {
  return !!role && (SPECIAL_CLAUSE_APPROVER_ROLES as readonly string[]).includes(role);
}

export function canAuthorSpecialClause(role: string | null | undefined): boolean {
  return !!role && (SPECIAL_CLAUSE_AUTHOR_ROLES as readonly string[]).includes(role);
}

export interface SpecialClauseGate {
  blocked: boolean;
  /** Plain-words reason shown next to the disabled action and in API errors. */
  reason: string | null;
}

/** An agreement can leave the building (email, e-sign, stamp) only when the
 *  contract has no special clause, or its clause is approved. */
export function specialClauseGate(
  status: string | null | undefined,
  submittedAt?: string | null,
): SpecialClauseGate {
  if (status === "pending_approval") {
    const when = submittedAt ? ` (submitted ${submittedAt})` : "";
    return {
      blocked: true,
      reason: `The special clause is awaiting approval from a manager or admin${when}. Sending unlocks once it is approved.`,
    };
  }
  if (status === "changes_requested") {
    return {
      blocked: true,
      reason: "The special clause needs changes. Revise and resubmit it to unblock sending.",
    };
  }
  return { blocked: false, reason: null };
}

/** The author edits only while nothing is awaiting a decision and nothing is locked. */
export function canReviseSpecialClause(status: string | null | undefined): boolean {
  return status === "changes_requested";
}
