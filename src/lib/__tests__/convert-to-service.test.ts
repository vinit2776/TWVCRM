import { describe, it, expect } from "vitest";
import { checkConvertToService, cycle1Period, suggestAssignments, suggestConversion, type ConvertAssignment, type ConvertInput } from "../procurement/convert-to-service";

const asg = (cycle: number, billId: string, from: string, to: string, over: Partial<ConvertAssignment["bill"]> = {}): ConvertAssignment => ({
  billId, cycle, from, to,
  bill: { po_id: "po1", service_report_id: null, approval_status: "approved", total_amount: 8032.5, ...over },
});

const base: ConvertInput = {
  role: "admin",
  po: { po_type: "goods", status: "invoice_received", total_ordered_amount: 16065, amc_terminated_at: null, isAmc: true },
  existingReports: 0,
  billingCycle: "half_yearly",
  cycleCount: 2,
  serviceStart: "2026-03-30",
  assignments: [asg(1, "b1", "2026-03-30", "2026-09-29")],
  poId: "po1",
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
  it("converts fine without any invoice tied", () => {
    expect(checkConvertToService(w({ assignments: [] }))).toEqual({ ok: true, unitCost: 8032.5 });
  });
  it("checks every chosen invoice", () => {
    const bad = (over: Partial<ConvertAssignment["bill"]>) => w({ assignments: [asg(1, "b1", "2026-03-30", "2026-09-29", over)] });
    expect(checkConvertToService(bad({ approval_status: "rejected" }))).toMatchObject({ ok: false });
    expect(checkConvertToService(bad({ service_report_id: "r" }))).toMatchObject({ ok: false });
    expect(checkConvertToService(bad({ po_id: "other" }))).toMatchObject({ ok: false });
    expect(checkConvertToService(bad({ total_amount: 9478.36 }))).toMatchObject({ ok: false });
    expect(checkConvertToService(w({ assignments: [asg(1, "b1", "2026-09-29", "2026-03-30")] }))).toMatchObject({ ok: false });
  });
  it("ties both invoices of a half-yearly contract to cycles 1 and 2", () => {
    expect(checkConvertToService(w({
      assignments: [asg(1, "b1", "2026-03-30", "2026-09-29"), asg(2, "b2", "2026-09-30", "2027-03-29")],
    }))).toEqual({ ok: true, unitCost: 8032.5 });
  });
  it("refuses a gap, so the engine never offers a cycle that is already billed", () => {
    expect(checkConvertToService(w({ assignments: [asg(2, "b2", "2026-09-30", "2027-03-29")] })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/no gap/) });
  });
  it("refuses two invoices on one cycle and the same invoice twice", () => {
    expect(checkConvertToService(w({ assignments: [asg(1, "b1", "2026-03-30", "2026-09-29"), asg(1, "b2", "2026-03-30", "2026-09-29")] })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/copy/) });
    expect(checkConvertToService(w({ assignments: [asg(1, "b1", "2026-03-30", "2026-09-29"), asg(2, "b1", "2026-09-30", "2027-03-29")] })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/same invoice/) });
  });
  it("refuses more invoices than cycles", () => {
    expect(checkConvertToService(w({ cycleCount: 1, billingCycle: "yearly", po: { ...base.po, total_ordered_amount: 8032.5 },
      assignments: [asg(1, "b1", "2026-03-30", "2027-03-29"), asg(2, "b2", "2026-03-30", "2027-03-29")] }))).toMatchObject({ ok: false });
  });
});

describe("suggestAssignments", () => {
  const sched = [{ n: 1, from: "2026-03-30", to: "2026-09-29" }, { n: 2, from: "2026-09-30", to: "2027-03-29" }];
  it("gives the older invoice cycle 1", () => {
    expect(suggestAssignments([{ id: "late", sortKey: "2026-10-01|B" }, { id: "early", sortKey: "2026-04-02|A" }], sched))
      .toEqual([
        { billId: "early", cycle: 1, from: "2026-03-30", to: "2026-09-29" },
        { billId: "late", cycle: 2, from: "2026-09-30", to: "2027-03-29" },
      ]);
  });
  it("leaves extra invoices unassigned rather than inventing a cycle", () => {
    expect(suggestAssignments([{ id: "a", sortKey: "1" }, { id: "b", sortKey: "2" }, { id: "c", sortKey: "3" }], sched)).toHaveLength(2);
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
