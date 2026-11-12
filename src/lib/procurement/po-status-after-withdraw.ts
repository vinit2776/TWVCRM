// Which status a goods PO returns to when one of its bills is withdrawn.
// Creating a bill moves the PO to invoice_received (and approving, to
// invoice_approved) without remembering what it was, so withdrawing has to
// work it back out.

export type PoStatusAfterWithdrawInput = {
  poType: string | null;
  poStatus: string;
  /** vendor_bills.po_status_before_bill of the bill being withdrawn (null on older bills). */
  statusBeforeBill: string | null;
  /** Other bills on the PO, withdrawn bill excluded. */
  otherBills: Array<{ approval_status: string }>;
  items: Array<{ quantity_ordered: number | string; quantity_received: number | string | null }>;
};

const RECEIVING_STATUSES = ["ordered", "partially_received", "received"];

/** Returns the status to set, or null to leave the PO alone. */
export function poStatusAfterWithdraw(i: PoStatusAfterWithdrawInput): string | null {
  // Service POs never took an invoice_* status, and a PO that has moved on
  // (cancelled, partially_cancelled…) is not ours to touch.
  if (i.poType === "service") return null;
  if (!["invoice_received", "invoice_approved"].includes(i.poStatus)) return null;

  // Another live bill still holds the PO at an invoice_* status; whatever the
  // create/approve flow last set stays correct, so leave it.
  if (i.otherBills.some((b) => !["rejected", "withdrawn"].includes(b.approval_status))) return null;

  if (i.statusBeforeBill && RECEIVING_STATUSES.includes(i.statusBeforeBill)) return i.statusBeforeBill;

  // Older bill: derive from what has actually been received (same rule as
  // rejecting a delivery in orders/[id]/deliveries).
  const allReceived =
    i.items.length > 0 &&
    i.items.every((it) => Number(it.quantity_received ?? 0) >= Number(it.quantity_ordered));
  const anyReceived = i.items.some((it) => Number(it.quantity_received ?? 0) > 0);
  return allReceived ? "received" : anyReceived ? "partially_received" : "ordered";
}
