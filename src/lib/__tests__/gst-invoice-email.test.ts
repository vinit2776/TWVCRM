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

import { buildInboxSendEmail, buildUploadEmail, escapeHtml } from "../gst-invoice-email";

describe("other customer emails", () => {
  it("inbox send: receipt vs payment link", () => {
    const paid = buildInboxSendEmail({ ...base, isReceipt: true, payLinkUrl: null });
    expect(paid.html).toContain("Thank you for your payment");
    const unpaid = buildInboxSendEmail({ ...base, payLinkUrl: "https://rzp.io/l/x" });
    expect(unpaid.html).toContain('href="https://rzp.io/l/x"');
    expect(buildInboxSendEmail({ ...base, payLinkUrl: null }).html).toContain("Kindly arrange payment");
  });
  it("upload email: shows payment options only with a link, escapes the name", () => {
    const input = { customerName: "A & <B>", periodLabel: "Oct 2026", invoiceNumber: "SD/A/26-27/1", refLabel: "Contract", contractNumber: "TWV-C-1", invoiceDateFormatted: "2 Nov 2026", amountFormatted: "1,000" };
    const withLink = buildUploadEmail({ ...input, payLinkUrl: "https://rzp.io/l/x" });
    expect(withLink.html).toContain("Pay Now");
    expect(withLink.html).toContain("A &amp; &lt;B&gt;");
    expect(buildUploadEmail({ ...input, payLinkUrl: null }).html).not.toContain("Pay Now");
    expect(withLink.subject).toBe("Tax Invoice SD/A/26-27/1 — TWV-C-1 — The WorkVilla");
  });
  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});
