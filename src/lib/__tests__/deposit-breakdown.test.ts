import { describe, expect, it } from "vitest";
import { buildDepositBreakdown, breakdownRows, type BreakdownContract } from "../deposit-breakdown";

const base = {
  deposit_carried_from: null,
  deposit_payment_status: null,
  deposit_payment_amount: null,
  security_deposit_amount: null,
  deposit_refunded_amount: null,
} as const;

const parent: BreakdownContract = {
  ...base, id: "p", contract_number: "TWV-C-0040", status: "renewed",
  deposit_payment_status: "paid", deposit_payment_amount: 52000, security_deposit_amount: 63064,
};
const renewal: BreakdownContract = {
  ...base, id: "r", contract_number: "TWV-C-0137", status: "active", deposit_carried_from: "p",
};
const need: Record<string, number> = { p: 63064, r: 66216 };

describe("buildDepositBreakdown", () => {
  it("splits a renewal into the previous term and the escalation, as on Acko", () => {
    const b = buildDepositBreakdown({
      contracts: [parent, renewal], excludedIds: new Set(["p"]),
      requiredFor: (c) => need[c.id], paidTopups: [], committed: 0, available: 52000,
    });
    expect(b.required.map((l) => [l.label, l.amount])).toEqual([
      ["TWV-C-0137", 66216],
      ["Previous term (TWV-C-0040)", 63064],
      ["Rate escalation on renewal", 3152],
    ]);
    expect(b.total_required).toBe(66216);
    expect(b.available).toBe(52000);
    expect(b.shortfall).toBe(14216);
    expect(b.unallocated).toBe(0);
  });

  it("keeps the leftover when the pool holds more than is needed (100k pool, 70k contract)", () => {
    const only: BreakdownContract = { ...base, id: "a", contract_number: "TWV-C-0001", status: "active", deposit_payment_status: "paid", deposit_payment_amount: 100000 };
    const b = buildDepositBreakdown({
      contracts: [only], excludedIds: new Set(), requiredFor: () => 70000, paidTopups: [], committed: 0, available: 100000,
    });
    expect(b.shortfall).toBe(0);
    expect(b.unallocated).toBe(30000);
  });

  it("lists top-ups by category and deductions in the pool", () => {
    const b = buildDepositBreakdown({
      contracts: [parent], excludedIds: new Set(),
      requiredFor: () => 63064,
      paidTopups: [{ amount: 5000, category: "seat_expansion" }, { amount: 1000, category: "seat_expansion" }],
      committed: 2000, available: 56000,
    });
    expect(b.held.map((l) => l.amount)).toEqual([52000, 6000, -2000]);
    expect(b.held[1].label).toContain("Seat / space expansion");
  });

  it("flattens to rows with a balance line", () => {
    const b = buildDepositBreakdown({
      contracts: [parent, renewal], excludedIds: new Set(["p"]),
      requiredFor: (c) => need[c.id], paidTopups: [], committed: 0, available: 52000,
    });
    const rows = breakdownRows(b);
    expect(rows.at(-1)).toMatchObject({ label: "Balance to pay", bold: true });
  });
});
