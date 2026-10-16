import { describe, it, expect } from "vitest";
import { checkConvertToService, cycle1Period, suggestConversion, type ConvertInput } from "../procurement/convert-to-service";

const base: ConvertInput = {
  role: "admin",
  po: { po_type: "goods", status: "invoice_received", total_ordered_amount: 16065, amc_terminated_at: null, isAmc: true },
  existingReports: 0,
  billingCycle: "half_yearly",
  cycleCount: 2,
  serviceStart: "2026-03-30",
  bill: { po_id: "po1", service_report_id: null, approval_status: "approved", total_amount: 8032.5 },
  poId: "po1",
  cycle1From: "2026-03-30",
  cycle1To: "2026-09-29",
};
const w = (p: Partial<ConvertInput>): ConvertInput => ({ ...base, ...p });

describe("checkConvertToService", () => {
  it("accepts the PO-2604-045 shape and returns the cycle cost", () => {
    expect(checkConvertToService(base)).toEqual({ ok: true, unitCost: 8032.5 });
  });
  it("is admin only", () => {
    expect(checkConvertToService(w({ role: "manager" }))).toMatchObject({ ok: false, status: 403 });
  });
  it("refuses a PO that is already a service PO or not an AMC", () => {
    expect(checkConvertToService(w({ po: { ...base.po, po_type: "service" } }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ po: { ...base.po, isAmc: false } }))).toMatchObject({ ok: false });
  });
  it("refuses cancelled, pending, and terminated contracts", () => {
    for (const status of ["cancelled", "partially_cancelled", "pending"]) {
      expect(checkConvertToService(w({ po: { ...base.po, status } }))).toMatchObject({ ok: false });
    }
    expect(checkConvertToService(w({ po: { ...base.po, amc_terminated_at: "2026-09-01" } }))).toMatchObject({ ok: false });
  });
  it("refuses when reports already exist", () => {
    expect(checkConvertToService(w({ existingReports: 1 }))).toMatchObject({ ok: false });
  });
  it("refuses a cycle count that does not split the total to the paisa", () => {
    expect(checkConvertToService(w({ cycleCount: 7 }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ cycleCount: 0 }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ billingCycle: "fortnightly" }))).toMatchObject({ ok: false });
  });
  it("converts fine without an invoice and then needs no period", () => {
    expect(checkConvertToService(w({ bill: null, cycle1From: null, cycle1To: null }))).toEqual({ ok: true, unitCost: 8032.5 });
  });
  it("checks the chosen invoice", () => {
    expect(checkConvertToService(w({ bill: { ...base.bill!, approval_status: "rejected" } }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ bill: { ...base.bill!, service_report_id: "r" } }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ bill: { ...base.bill!, po_id: "other" } }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ bill: { ...base.bill!, total_amount: 9478.36 } }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ cycle1To: "2026-03-01" }))).toMatchObject({ ok: false });
  });
});

describe("cycle1Period", () => {
  it("runs from the start to the day before the next cycle", () => {
    expect(cycle1Period("2026-03-30", "half_yearly")).toEqual({ from: "2026-03-30", to: "2026-09-29" });
    expect(cycle1Period("2026-04-01", "yearly")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(cycle1Period("2026-04-01", "monthly")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });
  it("returns null without a start date", () => {
    expect(cycle1Period(null, "yearly")).toBeNull();
  });
});

describe("suggestConversion", () => {
  it("reads two equal invoices on the PO as half-yearly", () => {
    expect(suggestConversion({ total: 16065, liveBillAmounts: [8032.5, 8032.5] })).toEqual({ billingCycle: "half_yearly", cycleCount: 2 });
  });
  it("falls back to one yearly cycle when the invoices don't line up", () => {
    expect(suggestConversion({ total: 16065, amcStart: "2026-03-30", amcEnd: "2027-03-29", liveBillAmounts: [9478.36] }))
      .toEqual({ billingCycle: "yearly", cycleCount: 1 });
    expect(suggestConversion({ total: 12000, liveBillAmounts: [] })).toEqual({ billingCycle: "yearly", cycleCount: 1 });
  });
});
