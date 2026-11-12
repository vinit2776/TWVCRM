import { describe, it, expect } from "vitest";
import { auditAmcs, type AuditPoInput } from "@/lib/procurement/amc-audit";

const base: AuditPoInput = {
  id: "po1",
  po_number: "PO-1",
  status: "ordered",
  po_type: "service",
  amc_terminated_at: null,
  amc_start_date: "2026-04-01",
  amc_end_date: "2027-03-31",
  billing_cycle: "yearly",
  cycle_count: 1,
  total_ordered_amount: 10000,
  assetIds: ["a1"],
  liveBills: 1,
  billedTotal: 10000,
};

const po = (over: Partial<AuditPoInput>): AuditPoInput => ({ ...base, ...over });
const codes = (r: ReturnType<typeof auditAmcs>, id: string) => r.get(id)!.issues.map((i) => i.code);

describe("auditAmcs", () => {
  it("passes a well-set-up AMC", () => {
    const r = auditAmcs([base]);
    expect(r.get("po1")).toEqual({ bucket: "clean", issues: [] });
  });

  it("marks a goods-typed AMC with no asset as fixable, not broken", () => {
    const r = auditAmcs([po({ po_type: "goods", assetIds: [] })]);
    expect(r.get("po1")!.bucket).toBe("fixable");
    expect(codes(r, "po1")).toEqual(expect.arrayContaining(["wrong_type", "no_asset"]));
  });

  it("flags more live bills than billing cycles as broken", () => {
    const r = auditAmcs([po({ liveBills: 3, cycle_count: 2, billedTotal: 10000 })]);
    expect(r.get("po1")!.bucket).toBe("broken");
    expect(codes(r, "po1")).toContain("over_billed");
  });

  it("flags an end date before the start date as broken", () => {
    const r = auditAmcs([po({ amc_end_date: "2026-03-01" })]);
    expect(codes(r, "po1")).toContain("bad_dates");
    expect(r.get("po1")!.bucket).toBe("broken");
  });

  it("flags two live AMCs on the same asset over the same dates, both ways", () => {
    const r = auditAmcs([po({ id: "a", po_number: "PO-A" }), po({ id: "b", po_number: "PO-B" })]);
    expect(codes(r, "a")).toContain("duplicate_cover");
    expect(codes(r, "b")).toContain("duplicate_cover");
  });

  it("does not call back-to-back terms on one asset a duplicate", () => {
    const r = auditAmcs([
      po({ id: "a", amc_end_date: "2027-03-31" }),
      po({ id: "b", po_number: "PO-B", amc_start_date: "2027-04-01", amc_end_date: "2028-03-31" }),
    ]);
    expect(r.get("a")!.bucket).toBe("clean");
    expect(r.get("b")!.bucket).toBe("clean");
  });

  it("ignores a cancelled or terminated AMC when looking for duplicates", () => {
    const r = auditAmcs([po({ id: "a" }), po({ id: "b", po_number: "PO-B", status: "cancelled" }), po({ id: "c", po_number: "PO-C", amc_terminated_at: "2026-08-01" })]);
    expect(r.get("a")!.bucket).toBe("clean");
    expect(r.get("b")!.bucket).toBe("retired");
    expect(r.get("c")!.bucket).toBe("retired");
  });

  it("tolerates GST on top of the PO value but not a large overshoot", () => {
    expect(auditAmcs([po({ billedTotal: 11800 })]).get("po1")!.bucket).toBe("clean");
    expect(codes(auditAmcs([po({ billedTotal: 20000 })]), "po1")).toContain("billed_over_value");
  });

  it("asks for billing frequency on a service AMC that lacks it", () => {
    const r = auditAmcs([po({ billing_cycle: null, cycle_count: null, liveBills: 0 })]);
    expect(codes(r, "po1")).toContain("no_cycle_setup");
  });
});
