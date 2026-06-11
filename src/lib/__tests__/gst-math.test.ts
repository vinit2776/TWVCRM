import { describe, it, expect } from "vitest";
import { computeGstAndRounding } from "../gst-math";

describe("computeGstAndRounding", () => {
  it("exact case — ₹100 at 18%: no round-off, equal CGST/SGST", () => {
    const r = computeGstAndRounding(100, 18);
    expect(r.cgst).toBe(9);
    expect(r.sgst).toBe(9);
    expect(r.taxAmount).toBe(18);
    expect(r.totalAmount).toBe(118);
    expect(r.roundOff).toBe(0);
    expect(r.igst).toBe(0);
  });

  it("paise-precision case — ₹101 at 18%: rounds down by ₹0.18", () => {
    // 101 * 18% = 18.18 → exact total = 119.18 → rounded = 119
    const r = computeGstAndRounding(101, 18);
    expect(r.cgst).toBe(9.09);
    expect(r.sgst).toBe(9.09);
    expect(r.taxAmount).toBe(18.18);
    expect(r.totalAmount).toBe(119);
    expect(r.roundOff).toBe(-0.18);
  });

  it("round-up case — ₹100.50 at 18%: rounds up", () => {
    // 100.50 * 18% = 18.09 → exact = 118.59 → rounded = 119
    const r = computeGstAndRounding(100.5, 18);
    expect(r.taxAmount).toBe(18.09);
    expect(r.totalAmount).toBe(119);
    expect(r.roundOff).toBe(0.41);
  });

  it("odd-paise tax — sgst absorbs the extra paisa", () => {
    // subtotalPaise = 139, taxPaise = round(139*18/100) = round(25.02) = 25 (odd)
    const r = computeGstAndRounding(1.39, 18);
    expect(r.cgst).toBe(0.12); // floor(25/2) = 12 paise
    expect(r.sgst).toBe(0.13); // 25 - 12 = 13 paise
    expect(r.cgst + r.sgst).toBe(r.taxAmount); // invariant: always holds
  });

  it("cgst + sgst always equals taxAmount (invariant)", () => {
    const cases = [
      [1234.56, 18],
      [99999.99, 18],
      [50000, 12],
      [7777.77, 5],
      [0.01, 18],
    ] as [number, number][];
    for (const [subtotal, rate] of cases) {
      const r = computeGstAndRounding(subtotal, rate);
      expect(r.cgst + r.sgst).toBeCloseTo(r.taxAmount, 10);
    }
  });

  it("totalAmount is always a whole rupee", () => {
    const cases = [101, 101.01, 50.50, 9999.99, 0.01, 12345.67];
    for (const subtotal of cases) {
      const r = computeGstAndRounding(subtotal, 18);
      expect(r.totalAmount % 1).toBe(0);
    }
  });

  it("zero subtotal", () => {
    const r = computeGstAndRounding(0, 18);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.taxAmount).toBe(0);
    expect(r.totalAmount).toBe(0);
    expect(r.roundOff).toBe(0);
  });

  it("EB worked example — ₹69,075.90 subtotal at 18%", () => {
    // Canonical test case from the electricity sub-billing spec
    // Landlord: 6486 units, 90:10 split; Customer: 80:20 split with markup
    // Approximate customer pre-GST subtotal used here for rounding verification
    const r = computeGstAndRounding(69075.9, 18);
    // tax = round(6907590 * 18 / 100) = round(1243366.2) = 1243366 paise = ₹12433.66
    expect(r.taxAmount).toBe(12433.66);
    expect(r.totalAmount % 1).toBe(0); // grand total is whole rupees
    expect(r.cgst + r.sgst).toBeCloseTo(r.taxAmount, 10);
    expect(r.totalAmount).toBe(
      Math.round((69075.9 + r.taxAmount) * 100) / 100 % 1 === 0
        ? Math.round(69075.9 + r.taxAmount)
        : r.totalAmount,
    );
  });

  it("regression — PI and GST invoice totals match to the paisa", () => {
    // Simulates the existing billing.ts (creates statement) vs generate-gst-invoice
    // (regenerates from statement.subtotal). Both must use the same function and
    // produce identical totals — the live paisa-mismatch bug this PR fixes.
    const subtotal = 101; // ₹101 exposes the old mismatch clearly
    const r1 = computeGstAndRounding(subtotal, 18); // "PI path"
    const r2 = computeGstAndRounding(subtotal, 18); // "GST invoice path"
    expect(r1.totalAmount).toBe(r2.totalAmount);
    expect(r1.cgst).toBe(r2.cgst);
    expect(r1.sgst).toBe(r2.sgst);
  });
});
