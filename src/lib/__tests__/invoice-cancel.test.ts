import { describe, it, expect } from "vitest";
import { canCancelInvoice, classifyForCancel } from "@/lib/invoice-cancel";

const base = {
  status: "finalized",
  payment_status: "unpaid",
  gst_invoice_number: null,
};

describe("canCancelInvoice", () => {
  it("allows admin and manager only", () => {
    expect(canCancelInvoice("admin")).toBe(true);
    expect(canCancelInvoice("manager")).toBe(true);
    expect(canCancelInvoice("accounts")).toBe(false);
    expect(canCancelInvoice("sales_rep")).toBe(false);
    expect(canCancelInvoice(null)).toBe(false);
  });
});

describe("classifyForCancel", () => {
  it("treats a sent CRM proforma as cancellable", () => {
    expect(classifyForCancel(base).kind).toBe("pi");
    expect(classifyForCancel({ ...base, payment_status: "partially_paid" }).kind).toBe("pi");
  });
  it("refuses drafts, voided, settled", () => {
    expect(classifyForCancel({ ...base, status: "draft" }).kind).toBe("unavailable");
    expect(classifyForCancel({ ...base, voided_at: "2026-10-01" }).kind).toBe("unavailable");
    expect(classifyForCancel({ ...base, payment_status: "paid" }).kind).toBe("unavailable");
  });
  it("refuses GST and Tally-channel invoices", () => {
    expect(classifyForCancel({ ...base, gst_invoice_number: "SDIPL-REG/1" }).kind).toBe("unavailable");
    expect(classifyForCancel({ ...base, issuance_channel: "tally" }).kind).toBe("unavailable");
  });
  it("refuses proposal, case and aggregator invoices", () => {
    expect(classifyForCancel({ ...base, proposal_id: "p" }).kind).toBe("unavailable");
    expect(classifyForCancel({ ...base, case_id: "c" }).kind).toBe("unavailable");
  });
});
