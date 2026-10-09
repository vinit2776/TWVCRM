/**
 * Pure logic behind the dashboard Procurement widget: collapses a purchase
 * order's lifecycle status and its vendor bills into one state, and grades
 * spend against a budget. No I/O — safe to unit test.
 *
 * A PO carries two independent facts — where the goods are (purchase_orders.status)
 * and whether the vendor has been paid (vendor_bills.payment_status). The widget
 * shows them as one ladder so a PO sits in exactly one bar segment.
 */

export const PO_WIDGET_STATES = [
  "pending",
  "ordered",
  "part_recv",
  "recv",
  "inv",
  "inv_ok",
  "part_paid",
  "paid",
  "cancelled",
] as const;
export type PoWidgetState = (typeof PO_WIDGET_STATES)[number];

export const PO_WIDGET_STATE_LABELS: Record<PoWidgetState, string> = {
  pending: "Pending",
  ordered: "Sent to vendor",
  part_recv: "Partly received",
  recv: "Received, no invoice",
  inv: "Invoice received",
  inv_ok: "Invoice approved, unpaid",
  part_paid: "Part-paid",
  paid: "Paid in full",
  cancelled: "Cancelled",
};

export const PO_WIDGET_STATE_COLORS: Record<PoWidgetState, string> = {
  pending: "#9AA5B1",
  ordered: "#378ADD",
  part_recv: "#EF9F27",
  recv: "#639922",
  inv: "#7F77DD",
  inv_ok: "#D4537E",
  part_paid: "#BA7517",
  paid: "#1D9E75",
  cancelled: "#B4B2A9",
};

/** Departments on a material request, plus a bucket for POs raised without one. */
export const PO_WIDGET_DEPARTMENTS = ["pantry", "maintenance", "administration", "asset", "amc", "reimbursement", "other"] as const;
export type PoWidgetDepartment = (typeof PO_WIDGET_DEPARTMENTS)[number];

export const PO_WIDGET_DEPARTMENT_LABELS: Record<PoWidgetDepartment, string> = {
  pantry: "Pantry",
  maintenance: "Maintenance",
  administration: "Administration",
  asset: "Asset",
  amc: "AMC",
  reimbursement: "Reimbursement",
  other: "No department",
};

export const PO_WIDGET_DEPARTMENT_COLORS: Record<PoWidgetDepartment, string> = {
  pantry: "#D85A30",
  maintenance: "#378ADD",
  administration: "#7F77DD",
  asset: "#1D9E75",
  amc: "#BA7517",
  reimbursement: "#D4537E",
  other: "#9AA5B1",
};

export function normaliseDepartment(d: string | null | undefined): PoWidgetDepartment {
  return (PO_WIDGET_DEPARTMENTS as readonly string[]).includes(d ?? "") ? (d as PoWidgetDepartment) : "other";
}

export interface PoBillShape {
  total_amount: number | string | null;
  amount_paid: number | string | null;
  approval_status: string | null;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);

/**
 * The single state a PO is shown in.
 *
 * Bills win over the PO's own status once any non-rejected bill exists, because
 * that is where payment truth lives. A PO with several bills is graded on the
 * whole: it is "paid" only when everything billed has been paid, "part-paid" as
 * soon as any money has gone out, and otherwise as complete as its least-complete
 * bill (one unapproved bill keeps it at "Invoice received"). Only vendor-bill
 * payments count — an advance is shown on the PO but does not move its state.
 */
export function derivePoState(po: { status: string | null }, bills: PoBillShape[]): PoWidgetState {
  const status = po.status ?? "";
  if (status === "cancelled") return "cancelled";

  const live = bills.filter((b) => b.approval_status !== "rejected");
  if (live.length > 0) {
    const billed = live.reduce((a, b) => a + num(b.total_amount), 0);
    const paid = live.reduce((a, b) => a + num(b.amount_paid), 0);
    if (billed > 0 && paid >= billed - 0.5) return "paid";
    if (paid > 0) return "part_paid";
    return live.every((b) => b.approval_status === "approved") ? "inv_ok" : "inv";
  }

  switch (status) {
    case "pending": return "pending";
    case "partially_received": return "part_recv";
    case "received": return "recv";
    case "invoice_received": return "inv";
    case "invoice_approved": return "inv_ok";
    default: return "ordered"; // ordered, partially_cancelled, anything newer
  }
}

export type BudgetGrade = "ok" | "warn" | "over" | "none";

/** Green under 80% of budget, amber up to 100%, red beyond; none when no budget is set. */
export function gradeBudget(spent: number, budget: number | null | undefined): BudgetGrade {
  if (!budget || budget <= 0) return "none";
  const pct = spent / budget;
  if (pct > 1) return "over";
  return pct >= 0.8 ? "warn" : "ok";
}
