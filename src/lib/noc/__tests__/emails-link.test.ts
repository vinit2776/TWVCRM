import { describe, expect, it } from "vitest";
import { buildCodeEmail, buildOfferEmail, buildReceiptEmail, rupees } from "../emails";
import { buildNocLinkPayload } from "../payment-link";

const offer = { customerName: "Mohamed", companyName: "ANIQA GLITZ PRIVATE LIMITED", purposeLabel: "GST Registration", centre: "Perungudi", feeExcl: 20000, tax: 3600, taxPercentage: 18, total: 23600, validUntilLabel: "31 Aug 2027", invoiceNumber: "INV-0100", link: "https://x.test/noc/abc" };

describe("emails", () => {
  it("the offer carries the amounts, the PI number, the validity and our own page link", () => {
    const e = buildOfferEmail(offer);
    expect(e.subject).toContain("INV-0100");
    expect(e.html).toContain("₹23,600");
    expect(e.html).toContain("31 Aug 2027");
    expect(e.html).toContain('href="https://x.test/noc/abc"');
    expect(e.html).toContain("GST Registration");
  });
  it("escapes anything the customer record could contain", () => {
    const e = buildOfferEmail({ ...offer, companyName: '<script>alert(1)</script>"x"' });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });
  it("the code email shows the code and how long it lasts", () => {
    const e = buildCodeEmail({ code: "482913", companyName: "ANIQA", minutes: 10 });
    expect(e.html).toContain("482913");
    expect(e.html).toContain("10 minutes");
  });
  it("the receipt shows the payment details and names the attached certificate", () => {
    const e = buildReceiptEmail({ customerName: "M", companyName: "ANIQA", purposeLabel: "ROC Registration", centre: "Perungudi", total: 23600, paidOnLabel: "24 Nov 2026", reference: "pay_Qx12", validUntilLabel: "31 Aug 2027", invoiceNumber: "INV-0100" });
    expect(e.html).toContain("pay_Qx12");
    expect(e.html).toContain("acceptance certificate");
    expect(buildReceiptEmail({ customerName: "M", companyName: "A", purposeLabel: "p", centre: "c", total: 1, paidOnLabel: "d", reference: null, validUntilLabel: "v", invoiceNumber: "i" }).html).toContain("recorded by our accounts team");
  });
  it("formats rupees", () => expect(rupees(1234567)).toBe("₹12,34,567"));
});

describe("the gateway link request", () => {
  const base = { totalRupees: 23600, invoiceNumber: "INV-0100", title: "NOC", invoiceId: "inv-1", nocId: "noc-1", nocNumber: "NOC-0001", token: "tok123", appUrl: "https://app.test/", customer: { name: "A", email: "a@example.com", phone: "+91 98765 43210" }, nowSeconds: 1000 };
  it("charges the exact total in paise and never lets the gateway message the customer", () => {
    const p = buildNocLinkPayload(base) as Record<string, unknown>;
    expect(p.amount).toBe(2360000);
    expect(p.notify).toEqual({ sms: false, email: false });
    expect(p.reminder_enable).toBe(false);
  });
  it("is booked as an ad-hoc invoice and returns the customer to the NOC page", () => {
    const p = buildNocLinkPayload(base) as Record<string, unknown> & { notes: Record<string, string> };
    expect(p.notes.type).toBe("adhoc_invoice");
    expect(p.notes.noc_id).toBe("noc-1");
    expect(p.callback_url).toBe("https://app.test/noc/tok123?razorpay_callback=true");
  });
  it("tidies the phone number and omits missing customer fields", () => {
    expect((buildNocLinkPayload(base) as { customer: { contact: string } }).customer.contact).toBe("+919876543210");
    expect((buildNocLinkPayload({ ...base, customer: {} }) as Record<string, unknown>).customer).toBeUndefined();
  });
});
