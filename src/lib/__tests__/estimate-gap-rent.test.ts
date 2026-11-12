import { describe, it, expect } from "vitest";
import { estimateGapRent } from "../unbilled-queue";

const noPhases = new Map();
const contract = {
  id: "c1",
  start_date: "2026-03-01",
  end_date: "2027-02-28",
  subtotal: 43750,
  total_amount: 51625,
  phase_start_date: null,
  tax_percentage: 18,
};

describe("estimateGapRent", () => {
  it("full month at the contract rate, with the GST split", () => {
    expect(estimateGapRent(contract, { year: 2026, month: 10 }, noPhases, []))
      .toEqual({ subtotal: 43750, tax: 7875, taxPercentage: 18, total: 51625 });
  });

  it("part month when the term ends mid-month", () => {
    const e = estimateGapRent({ ...contract, end_date: "2026-10-15" }, { year: 2026, month: 10 }, noPhases, []);
    // 15 of 31 days
    expect(e?.subtotal).toBeCloseTo((43750 / 31) * 15, 0);
    expect(e?.total).toBe(Math.round((e!.subtotal + e!.tax)));
  });

  it("adds a recurring add-on, pro-rated when it starts mid-month", () => {
    const e = estimateGapRent(contract, { year: 2026, month: 8 }, noPhases, [
      { amount: 3100, effective_from: "2026-08-17", effective_until: null }, // 15 of 31 days
    ]);
    expect(e?.subtotal).toBe(43750 + 1500);
  });

  it("returns null for a month the contract's own terms don't cover", () => {
    expect(estimateGapRent(contract, { year: 2027, month: 4 }, noPhases, [])).toBeNull();
  });
});
