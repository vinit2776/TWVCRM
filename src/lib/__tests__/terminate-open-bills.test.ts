import { describe, expect, it } from "vitest";
import { planTerminationBills, type TerminationBill } from "@/lib/procurement/terminate-open-bills";

const bill = (o: Partial<TerminationBill>): TerminationBill => ({
  id: "b", bill_number: "BILL-1", invoice_number: "1", approval_status: "pending",
  amount_paid: 0, payments: 0, electricity_bill_id: null, ...o,
});

describe("planTerminationBills", () => {
  it("withdraws a pending bill with no payment", () => {
    const p = planTerminationBills([bill({})]);
    expect(p.withdraw).toHaveLength(1);
    expect(p.keep).toHaveLength(0);
  });
  it("withdraws a pending bill that only carries advance credit", () => {
    expect(planTerminationBills([bill({ amount_paid: 9900 })]).withdraw).toHaveLength(1);
  });
  it("leaves approved and paid bills for a person", () => {
    const p = planTerminationBills([bill({ approval_status: "approved" }), bill({ id: "c", payments: 100 })]);
    expect(p.withdraw).toHaveLength(0);
    expect(p.keep).toHaveLength(2);
  });
  it("ignores rejected and withdrawn bills", () => {
    const p = planTerminationBills([bill({ approval_status: "rejected" }), bill({ approval_status: "withdrawn" })]);
    expect(p.withdraw).toHaveLength(0);
    expect(p.keep).toHaveLength(0);
  });
});
