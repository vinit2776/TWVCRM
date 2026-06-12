import { describe, it, expect } from "vitest";
import { computeCustomerRate, computeElectricityBill } from "@/lib/electricity";

// ---------------------------------------------------------------------------
// Worked example — verified manually with pen-and-paper paise arithmetic
//
// Setup: utility 500 units @ ₹8/unit, generator 200 units @ ₹12/unit
//   Landlord subtotal = 500×8 + 200×12 = ₹4,000 + ₹2,400 = ₹6,400
//   Landlord TDS (10%) = ₹640  →  net payable = ₹5,760
//
// per_unit +₹2 markup:
//   Customer subtotal = 500×10 + 200×14 = ₹5,000 + ₹2,800 = ₹7,800
//   GST 18% = ₹1,404 (CGST ₹702 + SGST ₹702), no rounding needed
//   Customer total = ₹9,204
//
// percent +15% markup:
//   Customer subtotal = 4000×1.15 + 2400×1.15 = ₹4,600 + ₹2,760 = ₹7,360
//   GST 18% = 7360×0.18 = ₹1,324.80 (CGST ₹662.40 + SGST ₹662.40)
//   exactTotal = ₹8,684.80  →  rounded ₹8,685  →  roundOff +₹0.20
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  reimbursement_enabled: true,
  customer_markup_type: "per_unit" as const,
  customer_markup_per_unit: 2,
  customer_markup_percent: 0,
  landlord_gst_rate: 0,
  landlord_tds_rate: 10,
};

const LINES = [
  { line_type: "utility" as const, units: 500, landlord_rate: 8 },
  { line_type: "generator" as const, units: 200, landlord_rate: 12 },
];

describe("computeCustomerRate", () => {
  it("per_unit: adds fixed markup to landlord rate", () => {
    expect(
      computeCustomerRate(
        { customer_markup_type: "per_unit", customer_markup_per_unit: 2, customer_markup_percent: 0 },
        8,
      ),
    ).toBe(10);
  });

  it("percent: multiplies landlord rate by (1 + pct/100)", () => {
    expect(
      computeCustomerRate(
        { customer_markup_type: "percent", customer_markup_per_unit: 0, customer_markup_percent: 15 },
        8,
      ),
    ).toBeCloseTo(9.2, 10);
  });

  it("per_unit zero markup: customer rate equals landlord rate", () => {
    expect(
      computeCustomerRate(
        { customer_markup_type: "per_unit", customer_markup_per_unit: 0, customer_markup_percent: 0 },
        12.5,
      ),
    ).toBe(12.5);
  });
});

describe("computeElectricityBill — per_unit markup", () => {
  const result = computeElectricityBill(BASE_CONFIG, LINES);

  it("landlord subtotal", () => expect(result.landlord_subtotal).toBe(6400));
  it("landlord GST (0%)", () => expect(result.landlord_gst).toBe(0));
  it("landlord TDS (10%)", () => expect(result.landlord_tds).toBe(640));
  it("landlord net payable", () => expect(result.landlord_net_payable).toBe(5760));

  it("customer subtotal", () => expect(result.customer_subtotal).toBe(7800));
  it("customer CGST", () => expect(result.customer_gst.cgst).toBe(702));
  it("customer SGST", () => expect(result.customer_gst.sgst).toBe(702));
  it("customer tax amount", () => expect(result.customer_gst.taxAmount).toBe(1404));
  it("customer round-off is zero", () => expect(result.customer_gst.roundOff).toBe(0));
  it("customer total", () => expect(result.customer_total).toBe(9204));

  it("line customer_rate and customer_amount", () => {
    expect(result.lines[0].customer_rate).toBe(10);
    expect(result.lines[0].customer_amount).toBe(5000);
    expect(result.lines[1].customer_rate).toBe(14);
    expect(result.lines[1].customer_amount).toBe(2800);
  });
});

describe("computeElectricityBill — percent markup", () => {
  const config = {
    ...BASE_CONFIG,
    customer_markup_type: "percent" as const,
    customer_markup_per_unit: 0,
    customer_markup_percent: 15,
  };
  const result = computeElectricityBill(config, LINES);

  it("customer subtotal", () => expect(result.customer_subtotal).toBe(7360));
  it("customer CGST", () => expect(result.customer_gst.cgst).toBe(662.40));
  it("customer SGST", () => expect(result.customer_gst.sgst).toBe(662.40));
  it("customer tax amount", () => expect(result.customer_gst.taxAmount).toBe(1324.80));
  it("customer round-off", () => expect(result.customer_gst.roundOff).toBe(0.20));
  it("customer total (rounded to nearest rupee)", () => expect(result.customer_total).toBe(8685));
});

describe("computeElectricityBill — reimbursement disabled", () => {
  const result = computeElectricityBill(
    { ...BASE_CONFIG, reimbursement_enabled: false },
    LINES,
  );

  it("customer subtotal is zero", () => expect(result.customer_subtotal).toBe(0));
  it("customer total is zero", () => expect(result.customer_total).toBe(0));
  it("landlord side unaffected", () => expect(result.landlord_subtotal).toBe(6400));
});

describe("computeElectricityBill — paise rounding, no float drift", () => {
  it("3 units @ ₹8.33/unit = ₹24.99 exactly", () => {
    const result = computeElectricityBill(
      { ...BASE_CONFIG, customer_markup_per_unit: 0 },
      [{ line_type: "utility", units: 3, landlord_rate: 8.33 }],
    );
    expect(result.landlord_subtotal).toBe(24.99);
    expect(result.customer_subtotal).toBe(24.99);
  });

  it("7 units @ ₹3.33/unit — landlord amount rounds correctly", () => {
    // 7 × 3.33 = 23.31 (exact), paise = 2331 → ₹23.31
    const result = computeElectricityBill(
      { ...BASE_CONFIG, customer_markup_per_unit: 0 },
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
    // subtotal = 1000, gst = 180, tds = 0, net = 1180
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
    // subtotal=1000, gst=180, tds=100, net = 1000+180-100 = 1080
    expect(result.landlord_net_payable).toBe(1080);
  });
});
