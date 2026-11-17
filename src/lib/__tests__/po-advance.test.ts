import { describe, it, expect } from "vitest";
import { advanceUsage } from "@/lib/procurement/po-advance";

describe("advance usage", () => {
  it("is all unused before any bill touches it", () => {
    expect(advanceUsage({ advance: 15000, appliedLines: [], bills: [{ amountPaid: 0, linesSum: 0 }] }))
      .toEqual({ advance: 15000, applied: 0, legacyCredit: 0, unused: 15000 });
  });
  it("subtracts standing advance applications", () => {
    const u = advanceUsage({ advance: 15000, appliedLines: [10000], bills: [{ amountPaid: 10000, linesSum: 10000 }] });
    expect(u.unused).toBe(5000);
    expect(u.legacyCredit).toBe(0);
  });
  it("counts old pre-credited money (paid with no payment line) as already used", () => {
    // PO-2604-047: one ₹15,611 advance credited to three bills with no payment lines.
    const u = advanceUsage({
      advance: 15611,
      appliedLines: [],
      bills: [{ amountPaid: 13230, linesSum: 0 }, { amountPaid: 13230, linesSum: 0 }, { amountPaid: 15611, linesSum: 0 }],
    });
    expect(u.legacyCredit).toBe(42071);
    expect(u.unused).toBe(0);
  });
  it("does not count a bill's real payments as advance credit", () => {
    const u = advanceUsage({ advance: 9000, appliedLines: [], bills: [{ amountPaid: 9000, linesSum: 9000 }] });
    expect(u.legacyCredit).toBe(0);
    expect(u.unused).toBe(9000);
  });
  it("never goes below zero", () => {
    expect(advanceUsage({ advance: 100, appliedLines: [150], bills: [] }).unused).toBe(0);
  });
});
