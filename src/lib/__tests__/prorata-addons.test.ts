import { describe, it, expect } from "vitest";
import { prorataAddonLines, prorataAddonsTotal } from "../prorata-addons";
import { buildProrataLineItems, computeProrataAmounts } from "../prorata-correction";
import type { AddonTerms } from "../addon-billing";

const valet: AddonTerms = {
  description: "Valet car parking",
  amount: 7000,
  effective_from: "2026-11-19",
  effective_until: "2027-05-18",
  is_active: true,
};

describe("prorataAddonLines", () => {
  it("prices an add-on that starts with the contract for the rest of the start month", () => {
    const lines = prorataAddonLines([valet], "2026-11-19");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      description: "Pro-Rata Valet car parking (Nov 19\u201330)",
      quantity: 1,
      unit_price: 2800,
      amount: 2800,
      monthly_rate: 7000,
      days_used: 12,
      days_in_month: 30,
    });
  });

  it("does not bill days before the contract starts", () => {
    const early = { ...valet, effective_from: "2026-11-01" };
    expect(prorataAddonLines([early], "2026-11-19")[0].amount).toBe(2800);
  });

  it("bills nothing for an add-on that has not started, ended, or is paused", () => {
    expect(prorataAddonLines([{ ...valet, effective_from: "2026-12-01" }], "2026-11-19")).toEqual([]);
    expect(prorataAddonLines([{ ...valet, effective_until: "2026-11-10" }], "2026-11-19")).toEqual([]);
    expect(prorataAddonLines([{ ...valet, is_active: false }], "2026-11-19")).toEqual([]);
  });

  it("stops at the add-on's own end date inside the start month", () => {
    const short = { ...valet, effective_until: "2026-11-24" };
    expect(prorataAddonLines([short], "2026-11-19")[0].amount).toBe(1400);
  });
});

describe("first-month invoice for TWV-C-0161 once valet is an add-on", () => {
  const monthlyFee = 36252;
  const fee = computeProrataAmounts({ monthlySubtotal: monthlyFee, startDate: "2026-11-19", taxPercentage: 18, isInterstate: false });
  const addonLines = prorataAddonLines([valet], "2026-11-19");
  const subtotal = Math.round((fee.subtotal + prorataAddonsTotal(addonLines)) * 100) / 100;

  it("cabin 14,500.80 + valet 2,800 = 17,300.80, the same as before the correction", () => {
    expect(fee.subtotal).toBe(14500.8);
    expect(prorataAddonsTotal(addonLines)).toBe(2800);
    expect(subtotal).toBe(17300.8);
    // GST and total on the sum, as the invoice route computes them
    const gst = Math.round(subtotal * 18) / 100;
    expect(gst).toBe(3114.14);
    expect(Math.round((subtotal + gst) * 100) / 100).toBe(20414.94);
  });

  it("puts the fee and the add-on on separate lines and sums the section", () => {
    const sections = buildProrataLineItems({
      startDate: "2026-11-19",
      prorataSubtotal: fee.subtotal,
      monthlySubtotal: monthlyFee,
      fixedShare: 0,
      addonLines,
    });
    expect(sections).toHaveLength(1);
    const items = sections[0].items as Array<{ description: string; amount: number }>;
    expect(items.map((i) => i.description)).toEqual([
      "Pro-Rata Workspace Fee (Nov 19\u201330)",
      "Pro-Rata Valet car parking (Nov 19\u201330)",
    ]);
    expect(items.map((i) => i.amount)).toEqual([14500.8, 2800]);
    expect(sections[0].subtotal).toBe(17300.8);
  });

  it("is exactly the old single-line section when there are no add-ons", () => {
    const sections = buildProrataLineItems({
      startDate: "2026-11-19",
      prorataSubtotal: 17300.8,
      monthlySubtotal: 43252,
      fixedShare: 0,
    });
    expect((sections[0].items as unknown[]).length).toBe(1);
    expect(sections[0].subtotal).toBe(17300.8);
  });
});
