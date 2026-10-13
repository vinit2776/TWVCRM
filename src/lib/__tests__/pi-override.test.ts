import { describe, it, expect } from "vitest";
import { canOverridePiToGst, hasLivePi, type PiOverrideStatement } from "../pi-override";

const live: PiOverrideStatement = {
  status: "finalized",
  payment_status: "unpaid",
  gst_invoice_number: null,
  pi_cancelled_at: null,
  proforma_sent_at: "2026-10-13T11:59:44Z",
};

describe("hasLivePi", () => {
  it("is true for a sent, unpaid, finalized PI", () => {
    expect(hasLivePi(live)).toBe(true);
  });
  it("stays true for a partially paid PI", () => {
    expect(hasLivePi({ ...live, payment_status: "partially_paid" })).toBe(true);
  });
  it("is false once paid, cancelled, voided or GST-invoiced", () => {
    expect(hasLivePi({ ...live, payment_status: "paid" })).toBe(false);
    expect(hasLivePi({ ...live, pi_cancelled_at: "2026-10-14T00:00:00Z" })).toBe(false);
    expect(hasLivePi({ ...live, voided_at: "2026-10-14T00:00:00Z" })).toBe(false);
    expect(hasLivePi({ ...live, gst_invoice_number: "INV/1" })).toBe(false);
  });
  it("is false when no PI was ever sent (GST Direct / draft)", () => {
    expect(hasLivePi({ ...live, proforma_sent_at: null })).toBe(false);
    expect(hasLivePi({ ...live, status: "draft" })).toBe(false);
  });
});

describe("canOverridePiToGst", () => {
  it("allows admin, manager and sales_rep only", () => {
    for (const r of ["admin", "manager", "sales_rep"]) expect(canOverridePiToGst(r)).toBe(true);
    for (const r of ["accounts", "fms", "office_admin", "", null, undefined]) expect(canOverridePiToGst(r)).toBe(false);
  });
});
