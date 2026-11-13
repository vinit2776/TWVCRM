import { describe, it, expect } from "vitest";
import { cycleSpan, serviceDateProblem, outsideCycleWarning } from "@/lib/procurement/service-report-period";

const po = { amc_start_date: "2025-12-01", amc_end_date: "2026-11-30", billing_cycle: "half_yearly" };

describe("service report period", () => {
  it("derives the cycle's dates from its number", () => {
    expect(cycleSpan(po, 1)).toEqual({ from: "2025-12-01", to: "2026-05-31" });
    expect(cycleSpan(po, 2)).toEqual({ from: "2026-06-01", to: "2026-11-30" });
  });
  it("has no span for a cycle past the end or a PO without dates", () => {
    expect(cycleSpan(po, 3)).toBeNull();
    expect(cycleSpan({ billing_cycle: "half_yearly" }, 1)).toBeNull();
  });
  it("blocks a future service date only", () => {
    expect(serviceDateProblem("2026-12-01", "2026-11-13")).toMatch(/future/);
    expect(serviceDateProblem("2026-11-13", "2026-11-13")).toBeNull();
  });
  it("warns, without blocking, when the date is outside the cycle", () => {
    const span = cycleSpan(po, 2);
    expect(outsideCycleWarning("2026-03-01", span)).toMatch(/outside this cycle/);
    expect(outsideCycleWarning("2026-07-01", span)).toBeNull();
    expect(outsideCycleWarning("2026-07-01", null)).toBeNull();
  });
});
