/**
 * An AMC is meant to cover an item the business already has, so the contract normally
 * starts once the item is received. This is only a heads-up: nothing is blocked and the
 * AMC's status is unchanged, because contracts that began before they were entered here
 * are recorded the same way.
 */
const NOT_RECEIVED = ["pending", "ordered", "partially_received"];

export const AMC_NOT_RECEIVED_WARNING =
  "Item not received yet — an AMC normally covers an item that has been received.";

export function amcNotReceived(po: { status: string; amc_terminated_at?: string | null }): boolean {
  return !po.amc_terminated_at && NOT_RECEIVED.includes(po.status);
}
