import { describe, it, expect } from "vitest";
import { annexureFromSections, buildElectricityAnnexure } from "@/lib/electricity-annexure";

const bill = {
  customer_units_billed: 5478,
  customer_utility_pct: 80,
  customer_generator_pct: 20,
  customer_utility_rate: 10,
  customer_generator_rate: 20,
  customer_subtotal: 65736,
  gst_rate: 18,
};

describe("buildElectricityAnnexure", () => {
  it("re-splits total units and prices each line at the customer's rate", () => {
    const a = buildElectricityAnnexure(bill, "September 2026");
    expect(a.totalUnits).toBe(5478);
    expect(a.lines).toEqual([
      { label: "Utility / grid", units: 4382.4, rate: 10, amount: 43824 },
      { label: "DG / generator", units: 1095.6, rate: 20, amount: 21912 },
    ]);
    expect(a.lines.reduce((s, l) => s + l.amount, 0)).toBe(a.subtotal);
  });

  it("totals with the same GST/rounding the invoice uses", () => {
    const a = buildElectricityAnnexure(bill, "September 2026");
    expect(a.cgst + a.sgst).toBeCloseTo(11832.48, 2);
    expect(a.total).toBe(77568);
    expect(a.subtotal + a.cgst + a.sgst + a.roundOff).toBeCloseTo(a.total, 2);
  });

  it("carries no landlord rate or margin", () => {
    const keys = JSON.stringify(buildElectricityAnnexure(bill, "September 2026"));
    expect(keys).not.toMatch(/landlord|margin|markup/i);
  });
});

describe("annexureFromSections", () => {
  it("finds the annexure on the electricity section", () => {
    const annexure = buildElectricityAnnexure(bill, "September 2026");
    expect(annexureFromSections([{ type: "rent" }, { type: "electricity", annexure }])).toEqual(annexure);
  });
  it("returns undefined for statements without one", () => {
    expect(annexureFromSections([{ type: "electricity", items: [] }])).toBeUndefined();
    expect(annexureFromSections(null)).toBeUndefined();
  });
});
