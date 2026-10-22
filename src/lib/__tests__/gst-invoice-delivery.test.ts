import { describe, it, expect } from "vitest";
import { wasCustomerEmailed } from "@/lib/gst-invoice-delivery";

describe("wasCustomerEmailed", () => {
  it("is false when nothing shows an email went out (e.g. only the bridge stamped delivery)", () => {
    expect(wasCustomerEmailed({ emailed_at: null, gst_invoice_sent_at: null, sentLogCount: 0 })).toBe(false);
  });
  it("is true when the statement has an emailed timestamp", () => {
    expect(wasCustomerEmailed({ emailed_at: "2026-10-21T13:00:00Z", gst_invoice_sent_at: null, sentLogCount: 0 })).toBe(true);
  });
  it("is true when the GST invoice sent timestamp is set", () => {
    expect(wasCustomerEmailed({ emailed_at: null, gst_invoice_sent_at: "2026-10-21T13:00:00Z", sentLogCount: 0 })).toBe(true);
  });
  it("is true when a 'sent' send-log row exists", () => {
    expect(wasCustomerEmailed({ emailed_at: null, gst_invoice_sent_at: null, sentLogCount: 1 })).toBe(true);
  });
});
