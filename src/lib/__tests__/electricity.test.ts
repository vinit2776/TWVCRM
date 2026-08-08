import { describe, it, expect } from "vitest";
import { computeCustomerRate, computeElectricityBill } from "@/lib/electricity";

// ---------------------------------------------------------------------------
// Real worked example (from ops) — verified manually with pen-and-paper paise
// arithmetic. This is the regression case for the 00322 ratio-of-total fix:
// the customer ratio re-splits the landlord's COMBINED total units (5,478),
// not each meter's sub-total independently — 90/10 landlord vs 80/20 customer.
//
//   Landlord: 4930.2 utility units @ ₹15.05 (variable) + 547.80 DG units @ ₹20 (fixed)
//     Landlord subtotal = 4930.2×15.05 + 547.80×20 = ₹74,199.51 + ₹10,956.00 = ₹85,155.51
//
//   Customer re-split of the SAME 5,478 total units: 80% utility / 20% DG
//     Customer utility units = 5478 × 0.80 = 4,382.4
//     Customer DG units      = 5478 × 0.20 = 1,095.6
//     Customer utility rate  = landlord effective rate (15.05) + ₹1.30 margin = ₹16.35
//     Customer DG rate       = landlord effective rate (20)    + ₹10 margin   = ₹30
//     Customer subtotal = 4382.4×16.35 + 1095.6×30 = ₹71,652.24 + ₹32,868.00 = ₹104,520.24
//     GST 18% = ₹18,813.64 (CGST ₹9,406.82 + SGST ₹9,406.82)
//     Customer total = ₹123,333.88 → rounded ₹123,334 → roundOff +₹0.12
// ---------------------------------------------------------------------------

const WORKED_EXAMPLE_CONFIG = {
  reimbursement_enabled: true,
  customer_utility_pct: 80,
  customer_generator_pct: 20,
  utility_markup_type: "per_unit" as const,
  utility_markup_value: 1.3,
  generator_markup_type: "per_unit" as const,
  generator_markup_value: 10,
  landlord_gst_rate: 0,
  landlord_tds_rate: 0,
};

const WORKED_EXAMPLE_LINES = [
  { line_type: "utility" as const, units: 4930.2, landlord_rate: 15.05 },
  { line_type: "generator" as const, units: 547.8, landlord_rate: 20 },
];

const BASE_CONFIG = {
  reimbursement_enabled: true,
  customer_utility_pct: 100,
  customer_generator_pct: 0,
  utility_markup_type: "per_unit" as const,
  utility_markup_value: 2,
  generator_markup_type: "per_unit" as const,
  generator_markup_value: 2,
  landlord_gst_rate: 0,
  landlord_tds_rate: 10,
};

describe("computeCustomerRate", () => {
  it("per_unit: adds fixed markup to landlord rate", () => {
    expect(computeCustomerRate({ markup_type: "per_unit", markup_value: 2 }, 8)).toBe(10);
  });

  it("percent: multiplies landlord rate by (1 + pct/100)", () => {
    expect(computeCustomerRate({ markup_type: "percent", markup_value: 15 }, 8)).toBeCloseTo(9.2, 10);
  });

  it("per_unit zero markup: customer rate equals landlord rate", () => {
    expect(computeCustomerRate({ markup_type: "per_unit", markup_value: 0 }, 12.5)).toBe(12.5);
  });
});

describe("computeElectricityBill — worked example (ratio applies to TOTAL units)", () => {
  const result = computeElectricityBill(WORKED_EXAMPLE_CONFIG, WORKED_EXAMPLE_LINES);

  it("landlord subtotal", () => expect(result.landlord_subtotal).toBeCloseTo(85155.51, 2));

  it("customer units are re-split from the COMBINED total (5478), not per-meter", () => {
    expect(result.customer_utility_units).toBeCloseTo(4382.4, 2);
    expect(result.customer_generator_units).toBeCloseTo(1095.6, 2);
  });

  it("customer rates are landlord's effective rate + fixed margin", () => {
    expect(result.customer_utility_rate).toBeCloseTo(16.35, 2);
    expect(result.customer_generator_rate).toBe(30);
  });

  it("customer subtotal", () => expect(result.customer_subtotal).toBeCloseTo(104520.24, 2));
  it("customer GST (CGST+SGST)", () => {
    expect(result.customer_gst.cgst).toBeCloseTo(9406.82, 2);
    expect(result.customer_gst.sgst).toBeCloseTo(9406.82, 2);
  });
  it("customer total (rounded to nearest rupee)", () => expect(result.customer_total).toBe(123334));
});

describe("computeElectricityBill — per_unit markup, single line type", () => {
  const result = computeElectricityBill(BASE_CONFIG, [
    { line_type: "utility", units: 500, landlord_rate: 8 },
  ]);

  it("landlord subtotal", () => expect(result.landlord_subtotal).toBe(4000));
  it("landlord TDS (10%)", () => expect(result.landlord_tds).toBe(400));
  it("landlord net payable", () => expect(result.landlord_net_payable).toBe(3600));

  it("customer units equal total when pct=100/0", () => {
    expect(result.customer_utility_units).toBe(500);
    expect(result.customer_generator_units).toBe(0);
  });
  it("customer rate = landlord rate + markup", () => expect(result.customer_utility_rate).toBe(10));
  it("customer subtotal", () => expect(result.customer_subtotal).toBe(5000));
});

describe("computeElectricityBill — percent markup", () => {
  const config = {
    ...BASE_CONFIG,
    utility_markup_type: "percent" as const,
    utility_markup_value: 15,
  };
  const result = computeElectricityBill(config, [{ line_type: "utility", units: 500, landlord_rate: 8 }]);

  it("customer subtotal", () => expect(result.customer_subtotal).toBeCloseTo(4600, 2));
});

describe("computeElectricityBill — reimbursement disabled", () => {
  const result = computeElectricityBill(
    { ...BASE_CONFIG, reimbursement_enabled: false },
    [{ line_type: "utility", units: 500, landlord_rate: 8 }],
  );

  it("customer subtotal is zero", () => expect(result.customer_subtotal).toBe(0));
  it("customer total is zero", () => expect(result.customer_total).toBe(0));
  it("landlord side unaffected", () => expect(result.landlord_subtotal).toBe(4000));
});

describe("computeElectricityBill — paise rounding, no float drift", () => {
  it("3 units @ ₹8.33/unit = ₹24.99 exactly", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, utility_markup_value: 0 },
      [{ line_type: "utility", units: 3, landlord_rate: 8.33 }],
    );
    expect(result.landlord_subtotal).toBe(24.99);
    expect(result.customer_subtotal).toBe(24.99);
  });

  it("7 units @ ₹3.33/unit — landlord amount rounds correctly", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, utility_markup_value: 0 },
      [{ line_type: "utility", units: 7, landlord_rate: 3.33 }],
    );
    expect(result.landlord_subtotal).toBe(23.31);
  });
});

describe("computeElectricityBill — GST on landlord bill", () => {
  it("landlord GST at 18%", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, landlord_gst_rate: 18, landlord_tds_rate: 0 },
      [{ line_type: "utility", units: 100, landlord_rate: 10 }],
    );
    expect(result.landlord_subtotal).toBe(1000);
    expect(result.landlord_gst).toBe(180);
    expect(result.landlord_tds).toBe(0);
    expect(result.landlord_net_payable).toBe(1180);
  });

  it("landlord GST + TDS together", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, landlord_gst_rate: 18, landlord_tds_rate: 10 },
      [{ line_type: "utility", units: 100, landlord_rate: 10 }],
    );
    expect(result.landlord_net_payable).toBe(1080);
  });
});

describe("computeElectricityBill — customer_gst_rate override", () => {
  it("defaults to 18% when omitted", () => {
    const result = computeElectricityBill(BASE_CONFIG, [
      { line_type: "utility", units: 500, landlord_rate: 8 },
    ]);
    expect(result.customer_gst.cgst).toBeCloseTo(450, 2);
    expect(result.customer_gst.sgst).toBeCloseTo(450, 2);
  });

  it("respects a non-18% profile rate (e.g. 12%)", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, customer_gst_rate: 12 },
      [{ line_type: "utility", units: 500, landlord_rate: 8 }],
    );
    expect(result.customer_subtotal).toBe(5000);
    expect(result.customer_gst.cgst).toBeCloseTo(300, 2);
    expect(result.customer_gst.sgst).toBeCloseTo(300, 2);
  });
});
