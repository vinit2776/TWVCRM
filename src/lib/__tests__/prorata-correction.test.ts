import { describe, it, expect } from "vitest";
import { computeProrataAmounts, prorataCorrectionBlocker, type CorrectionFacts } from "../prorata-correction";

describe("prorata correction", () => {
  it("TWV-C-0156 October: 248,620.80 for 28 of 31 days", () => {
    const a = computeProrataAmounts({ monthlySubtotal: 248620.8, startDate: "2026-10-04", taxPercentage: 18, isInterstate: false });
    expect(a.prorataDays).toBe(28);
    expect(a.subtotal).toBe(224560.72);
    expect(a.taxAmount).toBe(40420.93);
    expect(a.totalAmount).toBe(264981.65);
    expect(a.cgstAmount + a.sgstAmount).toBeCloseTo(40420.93, 2);
    expect(a.igstAmount).toBe(0);
  });

  it("matches what was billed at the old rate", () => {
    const a = computeProrataAmounts({ monthlySubtotal: 250637, startDate: "2026-10-04", taxPercentage: 18, isInterstate: false });
    expect(a.totalAmount).toBe(267130.54);
  });

  it("puts all tax on IGST for an interstate buyer", () => {
    const a = computeProrataAmounts({ monthlySubtotal: 248620.8, startDate: "2026-10-04", taxPercentage: 18, isInterstate: true });
    expect([a.cgstAmount, a.sgstAmount, a.igstAmount]).toEqual([0, 0, 40420.93]);
  });

  const ok: CorrectionFacts = {
    status: "finalized", statementType: "rent", paymentStatus: "unpaid", paymentsCount: 0, hasPaymentLink: false,
    gstInvoiceNumber: null, tallyInvoiceNumber: null, issuanceChannel: "crm", handoffState: "direct_gst_requested",
    liveUploadsCount: 0, hasSingleProrataLine: true,
  };

  it("allows an unissued, unpaid request waiting with accounts", () => {
    expect(prorataCorrectionBlocker(ok)).toBeNull();
  });

  it.each([
    ["paid", { paymentStatus: "paid" }],
    ["a payment row", { paymentsCount: 1 }],
    ["a payment link", { hasPaymentLink: true }],
    ["a GST invoice number", { gstInvoiceNumber: "SD/A/26-27/1" }],
    ["a live upload", { liveUploadsCount: 1 }],
    ["moved on by accounts", { handoffState: "ready_to_send" }],
    ["voided", { status: "voided" }],
  ])("blocks when %s", (_n, patch) => {
    expect(prorataCorrectionBlocker({ ...ok, ...patch })).not.toBeNull();
  });
});
