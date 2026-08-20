import { describe, it, expect } from "vitest";
import { rateDecimalsForLine, resolveLineItemQty, resolveLineItemRate } from "../billing-pdf-utils";

/** What the customer sees in the Unit Price column, then multiplies by Qty. */
const shownRate = (qty: number, rate: number, amount: number) =>
  Number(rate.toFixed(rateDecimalsForLine(qty, rate, amount)));

describe("rateDecimalsForLine", () => {
  it("keeps 2 dp when the rate already multiplies back exactly", () => {
    // 8 x 13,267 = 106,136 — the common case, must not gain decimals
    expect(rateDecimalsForLine(8, 13267, 106136)).toBe(2);
    expect(rateDecimalsForLine(1, 88445, 88445)).toBe(2);
  });

  it("widens to 3 dp for a terminating decimal that 2 dp would break (#498)", () => {
    // Contract TWV-C-0042: 16,799 / 3 seats. At 2 dp this printed 5,599.67,
    // and 3 x 5,599.67 = 16,799.01 — a paisa adrift of the stated total.
    expect(rateDecimalsForLine(3, 16799 / 3, 16799)).toBe(3);
    expect(shownRate(3, 16799 / 3, 16799) * 3).toBeCloseTo(16799, 2);
  });

  it("handles the widest real case — 28 seats on TWV-C-0055 (#498)", () => {
    // 353,785 / 28 = 12,635.178571... ; at 2 dp it overshot by 4 paise
    const dp = rateDecimalsForLine(28, 353785 / 28, 353785);
    expect(dp).toBeGreaterThan(2);
    expect(shownRate(28, 353785 / 28, 353785) * 28).toBeCloseTo(353785, 2);
  });

  it("reconciles a non-terminating rate to the paisa (#498)", () => {
    // Contract TWV-C-0019: 19,145 / 3 — never exact at any finite precision, but 3 dp
    // already brings it inside a paisa (6,381.667 x 3 = 19,145.001), so it rounds
    // to the amount on the customer's side. The helper takes the narrowest
    // precision that works rather than always widening to the maximum.
    const dp = rateDecimalsForLine(3, 19145 / 3, 19145);
    expect(dp).toBeGreaterThan(2);
    expect(dp).toBeLessThanOrEqual(5);
    expect(Math.abs(shownRate(3, 19145 / 3, 19145) * 3 - 19145)).toBeLessThan(0.005);
  });

  it("never exceeds 5 dp", () => {
    expect(rateDecimalsForLine(7, 100000 / 7, 100000)).toBeLessThanOrEqual(5);
    expect(rateDecimalsForLine(9, 1 / 9, 1)).toBeLessThanOrEqual(5);
  });

  it("falls back to 2 dp on unusable input rather than throwing", () => {
    expect(rateDecimalsForLine(0, 100, 100)).toBe(2);
    expect(rateDecimalsForLine(-3, 100, 300)).toBe(2);
    expect(rateDecimalsForLine(NaN, 100, 100)).toBe(2);
    expect(rateDecimalsForLine(3, NaN, 100)).toBe(2);
    expect(rateDecimalsForLine(3, 100, NaN)).toBe(2);
  });

  it("holds across a sweep of seat counts and rents", () => {
    // The invariant the smoke test checks by hand: Qty x Rate reconciles to the
    // Amount at paise precision, for every plausible cabin split.
    for (let seats = 1; seats <= 20; seats++) {
      for (const amount of [88445, 19145, 106136, 53068, 100000, 12345, 7]) {
        const rate = amount / seats;
        const drift = Math.abs(shownRate(seats, rate, amount) * seats - amount);
        expect(drift).toBeLessThan(0.005);
      }
    }
  });
});

describe("resolveLineItemQty / resolveLineItemRate", () => {
  it("reads the canonical fields", () => {
    expect(resolveLineItemQty({ qty: 8 })).toBe(8);
    expect(resolveLineItemRate({ unit_price: 11055.625 })).toBe(11055.625);
  });

  it("still honours the legacy field names", () => {
    expect(resolveLineItemQty({ quantity: 3 })).toBe(3);
    expect(resolveLineItemQty({ billable: 4 })).toBe(4);
    expect(resolveLineItemQty({ overage: 5 })).toBe(5);
    expect(resolveLineItemRate({ rate: 250 })).toBe(250);
  });

  it("defaults a missing qty to 1", () => {
    expect(resolveLineItemQty({ amount: 500 })).toBe(1);
  });
});
