import { describe, it, expect } from "vitest";
import { planAdvanceCancel, type AdvanceBill } from "@/lib/procurement/advance-cancel";

const bill = (over: Partial<AdvanceBill>): AdvanceBill => ({
  id: "b", bill_number: "BILL-1", approval_status: "approved", total_amount: 9900, gst_amount: null, amount_paid: 0, payments: 0, ...over,
});

describe("planAdvanceCancel", () => {
  it("clears the stale credit on a rejected bill and makes it unpaid", () => {
    const p = planAdvanceCancel([bill({ approval_status: "rejected", amount_paid: 9900 })]);
    expect(p.blockers).toEqual([]);
    expect(p.clears).toEqual([{ id: "b", bill_number: "BILL-1", credit: 9900, amount_paid: { from: 9900, to: 0 }, payment_status: "unpaid" }]);
  });
  it("refuses while a live bill carries credit with no payment of its own", () => {
    const p = planAdvanceCancel([bill({ approval_status: "approved", amount_paid: 9900 })]);
    expect(p.clears).toEqual([]);
    expect(p.blockers[0]).toMatch(/BILL-1 still shows ₹9,900/);
  });
  it("leaves a bill alone whose payments are real", () => {
    const p = planAdvanceCancel([bill({ amount_paid: 11682, payments: 11682, total_amount: 9900, gst_amount: 1782 })]);
    expect(p).toEqual({ blockers: [], clears: [] });
  });
  it("keeps the real part when a dead bill had both a payment and a credit", () => {
    const p = planAdvanceCancel([bill({ approval_status: "withdrawn", total_amount: 18000, amount_paid: 18000, payments: 9000 })]);
    expect(p.clears[0].amount_paid).toEqual({ from: 18000, to: 9000 });
    expect(p.clears[0].payment_status).toBe("partially_paid");
  });
  it("counts GST when judging whether the real payments cover the bill", () => {
    const p = planAdvanceCancel([bill({ approval_status: "rejected", total_amount: 9900, gst_amount: 1782, amount_paid: 12000, payments: 11682 })]);
    expect(p.clears[0].payment_status).toBe("paid");
  });
});
