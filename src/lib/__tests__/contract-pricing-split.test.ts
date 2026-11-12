import { describe, it, expect } from "vitest";
import { computePricingTotals, adjustDepositShortfall } from "../contract-pricing-split";

describe("contract pricing split", () => {
  it("TWV-C-0156: rent 219,820.80 (escalated) + maintenance 28,800 (fixed)", () => {
    const t = computePricingTotals(
      [
        { description: "Rent — A2 Wing", quantity: 1, unit_price: 219820.8, escalates: true },
        { description: "Maintenance", quantity: 1, unit_price: 28800, escalates: false },
      ],
      18,
      0
    );
    expect(t.subtotal).toBe(248620.8);
    expect(t.taxAmount).toBe(44751.74);
    expect(t.totalAmount).toBe(293372.54);
    expect(t.items.map((i) => i.total)).toEqual([219820.8, 28800]);
  });

  it("moves the deposit shortfall by the change in subtotal, keeping paid top-ups", () => {
    expect(adjustDepositShortfall(98382, 250637, 248620.8, 6)).toBe(86284.8);
    expect(adjustDepositShortfall(0, 250637, 240000, 6)).toBe(0);
  });
});
