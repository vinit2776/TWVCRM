// Admin rollback of material requests (revoke approval, reopen a cancelled MR).

/** MR statuses that mean "approved" — budget counts them as committed spend. */
export const MR_APPROVED_STATUSES = ["approved", "partially_ordered", "po_created"] as const;

/**
 * Where a cancelled MR goes when an admin reopens it: back to the status it was
 * cancelled from (draft or submitted). Cancelled MRs from before that was
 * recorded, or with anything unexpected stored, go to draft.
 */
export function mrStatusAfterReopen(statusBeforeCancel: string | null | undefined): "draft" | "submitted" {
  return statusBeforeCancel === "submitted" ? "submitted" : "draft";
}
