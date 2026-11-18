import { describe, expect, it } from "vitest";
import { buildGstInvoiceEmail } from "../gst-invoice-email";

const base = { partyName: "ABC Ltd", invoiceNumber: "SD/A/26-27/475", totalDisplay: "₹1,000", contractNumber: "TWV-C-1", isReceipt: false };

describe("buildGstInvoiceEmail", () => {
  it("leaves a normal send unchanged", () => {
    const { subject, html } = buildGstInvoiceEmail(base);
    expect(subject).toBe("GST tax invoice SD/A/26-27/475 — ₹1,000 due");
    expect(html).not.toMatch(/ignore/i);
  });
  it("tells the customer to ignore the earlier attachment on a replacement", () => {
    for (const isReceipt of [false, true]) {
      const { subject, html } = buildGstInvoiceEmail({ ...base, isReceipt, isReplacement: true });
      expect(subject.startsWith("Corrected: ")).toBe(true);
      expect(html).toContain("Please ignore the attachment in our previous email");
      expect(html).toContain("system error");
    }
  });
});
