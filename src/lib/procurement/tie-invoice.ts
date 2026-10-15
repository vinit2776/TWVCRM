export interface TieCheckInput {
  role: string;
  bill: { po_id: string | null; service_report_id: string | null; approval_status: string; total_amount: number | string };
  po: { po_type: string; status: string; unit_cost_per_cycle: number | string | null; amc_terminated_at?: string | null } | null;
  report: { po_id: string } | null;
  /** Bills already linked to the target report (any status). */
  billsOnReport: number;
  billPoId: string | null;
}

/**
 * Rules for tying an untied invoice to a service-report cycle.
 *
 * This repairs contracts whose invoices were uploaded before cycle billing existed
 * (e.g. an AMC first raised as a goods PO, then converted). It is admin-only and
 * deliberately narrow: the invoice must belong to the same service PO, be live,
 * and fit the cycle, so it cannot be used to move money between contracts.
 */
export function checkTieInvoiceToCycle(i: TieCheckInput): { ok: true } | { ok: false; error: string; status: number } {
  if (i.role !== "admin") return { ok: false, error: "Only an admin can tie an invoice to a cycle", status: 403 };
  if (!i.bill.po_id || !i.po) return { ok: false, error: "This invoice is not linked to a purchase order", status: 422 };
  if (i.po.po_type !== "service") return { ok: false, error: "Invoices can only be tied to cycles on a service PO", status: 422 };
  if (["cancelled", "partially_cancelled"].includes(i.po.status)) return { ok: false, error: "This purchase order is cancelled", status: 422 };
  if (i.bill.service_report_id) return { ok: false, error: "This invoice is already tied to a cycle", status: 422 };
  if (i.bill.approval_status === "rejected") {
    return { ok: false, error: "A rejected invoice can't be tied to a cycle. Correct and resubmit it, or leave it rejected", status: 422 };
  }
  if (!i.report || i.report.po_id !== i.bill.po_id) {
    return { ok: false, error: "That service report does not belong to this purchase order", status: 422 };
  }
  if (i.billsOnReport > 0) return { ok: false, error: "That cycle already has an invoice", status: 422 };
  const cap = Number(i.po.unit_cost_per_cycle ?? 0);
  if (cap > 0 && Number(i.bill.total_amount) > cap + 0.01) {
    return { ok: false, error: `This invoice (₹${Number(i.bill.total_amount).toLocaleString("en-IN")}) is more than one cycle's cost (₹${cap.toLocaleString("en-IN")})`, status: 422 };
  }
  return { ok: true };
}
