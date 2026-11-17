import { describe, it, expect } from "vitest";
import { computePricingTotals, adjustDepositShortfall, pricingCorrectionBlocker } from "../contract-pricing-split";

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

describe("TWV-C-0161: valet parking moved out of the fee", () => {
  it("leaves the cabin as the whole monthly fee", () => {
    const t = computePricingTotals(
      [{ description: "Private cabin", quantity: 4, unit_price: 9063, escalates: true }],
      18,
      0
    );
    expect(t.subtotal).toBe(36252);
    expect(t.taxAmount).toBe(6525.36);
    expect(t.totalAmount).toBe(42777.36);
  });

  it("brings the deposit still to collect from 20,592 to 6,592 (2 months, 43,252 to 36,252)", () => {
    expect(adjustDepositShortfall(20592, 43252, 36252, 2)).toBe(6592);
    // Required deposit is 2 x the monthly fee: 86,504 before, 72,504 after
    expect(2 * 43252).toBe(86504);
    expect(2 * 36252).toBe(72504);
  });
});

describe("pricingCorrectionBlocker", () => {
  it("allows a live contract", () => {
    expect(pricingCorrectionBlocker({ status: "active", is_renewal: false })).toBeNull();
    expect(pricingCorrectionBlocker({ status: "active", is_renewal: true })).toBeNull();
  });

  it("allows a renewal that is accepted but not yet active", () => {
    expect(pricingCorrectionBlocker({ status: "accepted", is_renewal: true })).toBeNull();
  });

  it("refuses an accepted contract that is not a renewal (its fee comes from its proposal)", () => {
    expect(pricingCorrectionBlocker({ status: "accepted", is_renewal: false })).not.toBeNull();
    expect(pricingCorrectionBlocker({ status: "accepted" })).not.toBeNull();
  });

  it("refuses every other status", () => {
    for (const status of ["draft", "sent", "viewed", "rejected", "expired", "terminated", "renewed", "renewal_in_progress"]) {
      expect(pricingCorrectionBlocker({ status, is_renewal: true })).not.toBeNull();
    }
  });
});
