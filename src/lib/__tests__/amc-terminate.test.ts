import { describe, it, expect } from "vitest";
import { terminateBlocker, terminationPatch, type TerminablePo } from "@/lib/procurement/amc-terminate";

const base: TerminablePo = {
  po_type: "service",
  status: "ordered",
  amc_terminated_at: null,
  amc_start_date: "2026-04-01",
  amc_status: "active",
};
const po = (over: Partial<TerminablePo>): TerminablePo => ({ ...base, ...over });

describe("terminateBlocker", () => {
  it("allows a live service AMC", () => {
    expect(terminateBlocker(base, true)).toBeNull();
  });

  it("allows AMCs the old rule refused: expired, exhausted, inactive, goods-typed", () => {
    expect(terminateBlocker(po({ amc_status: "expired" }), true)).toBeNull();
    expect(terminateBlocker(po({ amc_status: "exhausted" }), true)).toBeNull();
    expect(terminateBlocker(po({ amc_status: "inactive", amc_start_date: null }), true)).toBeNull();
    expect(terminateBlocker(po({ po_type: "goods" }), true)).toBeNull();
  });

  it("allows a goods-typed AMC identified only by its dates", () => {
    expect(terminateBlocker(po({ po_type: "goods" }), false)).toBeNull();
  });

  it("refuses one already terminated or cancelled", () => {
    expect(terminateBlocker(po({ amc_terminated_at: "2026-11-01T00:00:00Z" }), true)).toBe("Already terminated");
    expect(terminateBlocker(po({ status: "cancelled" }), true)).toBe("The purchase order is cancelled");
  });

  it("refuses a PO that has not been ordered yet; cancel it instead", () => {
    expect(terminateBlocker(po({ status: "pending" }), true)).toBe("Not ordered yet — cancel the purchase order instead");
  });

  it("refuses a PO that is not an AMC at all", () => {
    expect(terminateBlocker(po({ po_type: "goods", amc_start_date: null, amc_status: "inactive" }), false)).toBe("Not an AMC");
  });
});

describe("terminationPatch", () => {
  it("stamps the termination and trims the reason", () => {
    const p = terminationPatch("u1", "  set up wrongly  ");
    expect(p.amc_status).toBe("terminated");
    expect(p.amc_terminated_by).toBe("u1");
    expect(p.amc_termination_reason).toBe("set up wrongly");
    expect(Number.isNaN(Date.parse(p.amc_terminated_at))).toBe(false);
  });
});
