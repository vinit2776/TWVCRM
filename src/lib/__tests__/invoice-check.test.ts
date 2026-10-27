import { describe, expect, it } from "vitest";
import { checkInvoice, vendorNamesMatch, type EnteredBill, type ExtractedInvoice } from "../procurement/invoice-check";

const extracted: ExtractedInvoice = {
  invoiceNumber: "INV/26-27/0412",
  invoiceDate: "2026-10-10",
  vendorName: "Sharma Office Supplies Pvt Ltd",
  subtotal: 15435,
  gstAmount: 2778.3,
  grandTotal: 18213.3,
  confidence: "high",
};

const entered: EnteredBill = {
  invoiceNumber: "INV/26-27/0412",
  invoiceDate: "2026-10-10",
  vendorName: "Sharma Office Supplies",
  amount: 15435,
  gstAmount: 2778.3,
};

const codes = (e: Partial<EnteredBill>, x: Partial<ExtractedInvoice> = {}, po: number | null = 15435) =>
  checkInvoice({ extracted: { ...extracted, ...x }, entered: { ...entered, ...e }, poCeiling: po }).map((f) => f.code);

describe("checkInvoice", () => {
  it("is quiet when everything agrees", () => {
    expect(codes({})).toEqual([]);
  });

  it("flags a GST-inclusive amount (BILL-2610-019) and suggests the pre-GST figure", () => {
    const f = checkInvoice({ extracted, entered: { ...entered, amount: 18213.3 }, poCeiling: 15435 });
    const gstFinding = f.find((x) => x.code === "amount_looks_gst_inclusive");
    expect(gstFinding?.suggestion).toMatchObject({ field: "amount", value: "15435" });
    expect(f.some((x) => x.code === "amount_differs_subtotal")).toBe(false);
  });

  it("detects the inclusive case from whole-rupee entry too", () => {
    expect(codes({ amount: 18213 })).toContain("amount_looks_gst_inclusive");
  });

  it("derives the subtotal when only total and GST were read", () => {
    expect(codes({ amount: 18213.3 }, { subtotal: null })).toContain("amount_looks_gst_inclusive");
  });

  it("flags an amount that differs from the subtotal", () => {
    expect(codes({ amount: 14000 })).toContain("amount_differs_subtotal");
  });

  it("does not call it GST-inclusive when the invoice has no GST", () => {
    expect(codes({ amount: 15435, gstAmount: null }, { gstAmount: 0, grandTotal: 15435 })).toEqual([]);
  });

  it("flags GST mismatches only when GST was entered", () => {
    expect(codes({ gstAmount: 1000 })).toContain("gst_differs");
    expect(codes({ gstAmount: null })).not.toContain("gst_differs");
  });

  it("flags invoice number and date mismatches, ignoring punctuation and case", () => {
    expect(codes({ invoiceNumber: "inv-26-27-0412" })).toEqual([]);
    expect(codes({ invoiceNumber: "INV/26-27/0999" })).toContain("invoice_number_mismatch");
    expect(codes({ invoiceDate: "2026-10-11" })).toContain("invoice_date_mismatch");
    expect(codes({ invoiceNumber: "" })).toEqual([]);
  });

  it("flags a different vendor", () => {
    expect(codes({ vendorName: "Acme Cleaning Services" })).toContain("vendor_mismatch");
    expect(codes({ vendorName: null })).toEqual([]);
  });

  it("flags an amount above the PO ceiling", () => {
    expect(codes({ amount: 18213.3 })).toContain("amount_above_po");
    expect(codes({ amount: 15435 }, {}, null)).toEqual([]);
  });

  it("stays silent about fields the invoice did not yield", () => {
    expect(
      codes({}, { invoiceNumber: null, invoiceDate: null, vendorName: null, subtotal: null, gstAmount: null, grandTotal: null }),
    ).toEqual([]);
  });
});

describe("vendorNamesMatch", () => {
  it("ignores company suffixes and punctuation", () => {
    expect(vendorNamesMatch("M/s. Sharma Office Supplies Pvt. Ltd.", "sharma office supplies")).toBe(true);
    expect(vendorNamesMatch("Sharma Office Supplies", "Acme Cleaning")).toBe(false);
  });
});
