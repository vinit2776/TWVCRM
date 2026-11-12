/**
 * Which payable (vendor bill) belongs to an electricity bill, and where it came from.
 *
 * Two routes lead to one:
 *  - "created":  made together with the bill at capture (`vendor_bill_id`), or, for a revised draft that
 *                lost the link, the payable of the bill it was revised from (`fallbackId`).
 *  - "uploaded": an invoice someone uploaded under Procurement → Bills and then linked here
 *                (`source_vendor_bill_id`). It sits in its own column on purpose so approving, editing or
 *                deleting this bill can never touch an uploaded payable — which is also why anything that
 *                reads only `vendor_bill_id` wrongly concludes "no vendor bill".
 */
export interface VendorBillRefs {
  vendor_bill_id?: string | null;
  source_vendor_bill_id?: string | null;
}

export interface ResolvedVendorBill {
  id: string | null;
  origin: "created" | "uploaded" | null;
}

export function resolveVendorBillRef(bill: VendorBillRefs, fallbackId?: string | null): ResolvedVendorBill {
  const created = bill.vendor_bill_id ?? fallbackId ?? null;
  if (created) return { id: created, origin: "created" };
  if (bill.source_vendor_bill_id) return { id: bill.source_vendor_bill_id, origin: "uploaded" };
  return { id: null, origin: null };
}
