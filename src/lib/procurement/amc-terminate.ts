/**
 * Who and what can be terminated, shared by the single "Terminate AMC" action and the
 * bulk terminate on the audit page so the two cannot disagree.
 *
 * Terminating ends the contract going forward. Bills, payments, TDS and visit history stay
 * exactly as they are, and Reinstate puts it back.
 */

export const TERMINATE_ROLES = ["admin", "manager"] as const;
export const BULK_TERMINATE_ROLES = ["admin"] as const;
export const TERMINATION_REASON_MIN = 10;

export interface TerminablePo {
  po_type: string | null;
  status: string;
  amc_terminated_at: string | null;
  amc_start_date: string | null;
  amc_status: string | null;
}

/**
 * Why this PO cannot be terminated, or null when it can. An AMC is anything the request
 * says is one, or anything carrying AMC dates, so contracts that were set up wrongly
 * (raised as goods, never given a status) can still be retired.
 */
export function terminateBlocker(po: TerminablePo, requestIsAmc: boolean): string | null {
  if (po.amc_terminated_at) return "Already terminated";
  if (po.status === "cancelled") return "The purchase order is cancelled";
  // Nothing has been ordered, so there is no contract to end. Cancelling is the right retire.
  if (po.status === "pending") return "Not ordered yet — cancel the purchase order instead";
  const isAmc = po.po_type === "service" || requestIsAmc || !!po.amc_start_date || (po.amc_status ?? "inactive") !== "inactive";
  if (!isAmc) return "Not an AMC";
  return null;
}

export function terminationPatch(userId: string, reason: string) {
  return {
    amc_terminated_at: new Date().toISOString(),
    amc_terminated_by: userId,
    amc_termination_reason: reason.trim(),
    amc_status: "terminated",
  };
}
