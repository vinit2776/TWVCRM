import { describe, it, expect } from "vitest";
import { checkTieInvoiceToCycle, type TieCheckInput } from "../procurement/tie-invoice";

const base: TieCheckInput = {
  role: "admin",
  bill: { po_id: "po1", service_report_id: null, approval_status: "pending", total_amount: 8032.5 },
  po: { po_type: "service", status: "ordered", unit_cost_per_cycle: 8032.5 },
  report: { po_id: "po1" },
  billsOnReport: 0,
  billPoId: "po1",
};
const with_ = (p: Partial<TieCheckInput>) => ({ ...base, ...p });

describe("checkTieInvoiceToCycle", () => {
  it("allows a live untied invoice onto an empty cycle of its own service PO", () => {
    expect(checkTieInvoiceToCycle(base)).toEqual({ ok: true });
  });

  it("is admin only", () => {
    const r = checkTieInvoiceToCycle(with_({ role: "manager" }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a goods PO", () => {
    expect(checkTieInvoiceToCycle(with_({ po: { po_type: "goods", status: "ordered", unit_cost_per_cycle: null } }))).toMatchObject({ ok: false });
  });

  it("refuses an invoice that is already tied", () => {
    expect(checkTieInvoiceToCycle(with_({ bill: { ...base.bill, service_report_id: "r0" } }))).toMatchObject({ ok: false });
  });

  it("refuses a rejected invoice", () => {
    expect(checkTieInvoiceToCycle(with_({ bill: { ...base.bill, approval_status: "rejected" } }))).toMatchObject({ ok: false });
  });

  it("refuses a report from another PO", () => {
    expect(checkTieInvoiceToCycle(with_({ report: { po_id: "other" } }))).toMatchObject({ ok: false });
    expect(checkTieInvoiceToCycle(with_({ report: null }))).toMatchObject({ ok: false });
  });

  it("refuses a cycle that already has an invoice", () => {
    expect(checkTieInvoiceToCycle(with_({ billsOnReport: 1 }))).toMatchObject({ ok: false });
  });

  it("refuses an invoice bigger than one cycle, with a rupee of rounding slack", () => {
    expect(checkTieInvoiceToCycle(with_({ bill: { ...base.bill, total_amount: 9000 } }))).toMatchObject({ ok: false });
    expect(checkTieInvoiceToCycle(with_({ bill: { ...base.bill, total_amount: "8032.50" } }))).toEqual({ ok: true });
  });
});
