import { describe, it, expect } from "vitest";
import { billAmountCeiling } from "../procurement/bill-ceiling";

describe("billAmountCeiling", () => {
  it("is the cycle cost on a service PO, not the whole contract", () => {
    expect(billAmountCeiling({ po_type: "service", total_ordered_amount: 20790, unit_cost_per_cycle: 10395 })).toBe(10395);
  });
  it("is the PO value on a goods PO", () => {
    expect(billAmountCeiling({ po_type: "goods", total_ordered_amount: 20790 })).toBe(20790);
  });
  it("falls back to the PO value when a service PO has no cycle cost yet", () => {
    expect(billAmountCeiling({ po_type: "service", total_ordered_amount: 20790, unit_cost_per_cycle: null })).toBe(20790);
  });
  it("is null when there is nothing to compare against", () => {
    expect(billAmountCeiling({ po_type: "goods", total_ordered_amount: 0 })).toBeNull();
  });
});
