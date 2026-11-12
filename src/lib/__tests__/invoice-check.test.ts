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

describe("tolerance for scanned bills", () => {
  it("forgives small spelling slips and spacing in vendor names", () => {
    expect(vendorNamesMatch("Prakashchand Chordia", "Prakash Chand Chordia")).toBe(true);
    expect(vendorNamesMatch("H Prakashchand Chordia", "H Prakashchand Chordya")).toBe(true);
    expect(vendorNamesMatch("Godrej Finance Limited", "Godrei Finance Ltd")).toBe(true);
  });
  it("forgives letter/digit look-alikes in an invoice number but not a wrong digit", () => {
    expect(codes({ invoiceNumber: "INV/26-27/O412" })).toEqual([]);
    expect(codes({ invoiceNumber: "INV/26-27/0413" })).toContain("invoice_number_mismatch");
  });
  it("still rejects a different vendor", () => {
    expect(vendorNamesMatch("H Prakashchand Chordia", "Sharma Office Supplies")).toBe(false);
  });
});

import { compareLines, fingerprintLines, invoiceSeal, buildInvoiceCheckRecord, type EnteredLine, type ExtractedLine } from "../procurement/invoice-check";

describe("electricity charge lines", () => {
  const invoiceLines: ExtractedLine[] = [
    { description: "EB units", kind: "utility", units: 2185.6, rate: 18.25, amount: 39887.2 },
    { description: "DG units", kind: "generator", units: 273.2, rate: 20, amount: 5464 },
  ];
  const typed: EnteredLine[] = [
    { line_type: "utility", units: 2185.6, rate: 18.25, amount: 39887.2 },
    { line_type: "generator", units: 273.2, rate: 20, amount: 5464 },
  ];

  it("matches lines by figures even when the wording differs", () => {
    const r = compareLines(invoiceLines.map((l) => ({ ...l, description: "Something else" })), typed);
    expect(r.findings).toEqual([]);
  });

  it("flags units and rates typed wrongly even when they are all present", () => {
    const wrong: EnteredLine[] = [
      { line_type: "utility", units: 268.4, rate: 20, amount: 5368 },
      { line_type: "generator", units: 2415.6, rate: 15.65, amount: 37803.9 },
    ];
    const r = compareLines(invoiceLines, wrong);
    expect(r.findings.map((f) => f.code)).toEqual(["line_not_on_invoice", "line_not_on_invoice", "invoice_line_not_entered", "invoice_line_not_entered"]);
  });

  it("flags a category swap with the right figures", () => {
    const swapped: EnteredLine[] = [
      { line_type: "generator", units: 2185.6, rate: 18.25, amount: 39887.2 },
      { line_type: "generator", units: 273.2, rate: 20, amount: 5464 },
    ];
    expect(compareLines(invoiceLines, swapped).findings.map((f) => f.code)).toEqual(["line_category_differs"]);
  });

  it("flags an invoice row that was never entered", () => {
    expect(compareLines(invoiceLines, typed.slice(0, 1)).findings.map((f) => f.code)).toEqual(["invoice_line_not_entered"]);
  });

  it("uses each invoice row once", () => {
    const dup = [typed[1], typed[1]];
    expect(compareLines([invoiceLines[1]], dup).matches.map((m) => m.status)).toEqual(["match", "not_on_invoice"]);
  });
});

describe("invoiceSeal", () => {
  const lines: EnteredLine[] = [{ line_type: "utility", units: 100, rate: 10, amount: 1000 }];
  const clean: ExtractedInvoice = { ...extracted, subtotal: 1000, gstAmount: 180, grandTotal: 1180, lines: [{ description: "EB", kind: "utility", units: 100, rate: 10, amount: 1000 }] };
  const enteredWithLines: EnteredBill = { ...entered, amount: 1000, gstAmount: 180, lines, gstRate: 18 };
  const record = (x: ExtractedInvoice, e: EnteredBill, reason?: string) =>
    buildInvoiceCheckRecord(x, checkInvoice({ extracted: x, entered: e, poCeiling: null }), reason, e);

  it("is verified only when lines were read and everything matched", () => {
    const rec = record(clean, enteredWithLines);
    expect(invoiceSeal(rec, fingerprintLines(lines, 18)).state).toBe("verified");
  });

  it("is not verified when the charge lines were not read, even if the totals match", () => {
    const rec = record({ ...clean, lines: [] }, enteredWithLines);
    expect(invoiceSeal(rec, fingerprintLines(lines, 18)).state).toBe("not_verified");
  });

  it("is not verified on a low-confidence read", () => {
    expect(invoiceSeal(record({ ...clean, confidence: "low" }, enteredWithLines), null).state).toBe("not_verified");
  });

  it("is overridden, never verified, when differences were saved with a reason", () => {
    const rec = record(clean, { ...enteredWithLines, lines: [{ ...lines[0], units: 90, amount: 900 }], amount: 900 }, "invoice is wrong");
    expect(invoiceSeal(rec, null).state).toBe("overridden");
  });

  it("drops the seal once the bill is edited after the check", () => {
    const rec = record(clean, enteredWithLines);
    expect(invoiceSeal(rec, fingerprintLines([{ ...lines[0], units: 101 }], 18)).state).toBe("changed_after");
    expect(invoiceSeal(rec, fingerprintLines(lines, 5)).state).toBe("changed_after");
  });

  it("is never verified for a bill with no stored check", () => {
    expect(invoiceSeal(null, null).state).toBe("not_verified");
    expect(invoiceSeal({ checked_at: "x", confidence: "high", findings: [] }, null).state).toBe("not_verified");
  });
});
