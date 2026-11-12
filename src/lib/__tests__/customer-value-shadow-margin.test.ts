import { describe, expect, it } from "vitest";
import { shadowMargin, summariseShadow, tenureAt, type ShadowMonthInput } from "@/lib/customer-value/shadow-margin";

const base: ShadowMonthInput = {
  month: "2026-09-01", revenue_ex_gst: 120_000, seats_paid: 10, rent_per_seat: 10_000, concessions_counted: 2_000,
  avg_days_late: 10, measured_count: 2, seats_used_avg: null, electricityCost: 8_000, staffMinutes: null, tenureMonths: 12, params: {},
};

describe("shadowMargin", () => {
  it("with no rates entered costs only what is measured", () => {
    const m = shadowMargin(base)!;
    expect(m.variable_cost).toBe(10_000); // electricity 8,000 + concessions 2,000
    expect(m.margin_after_variable).toBe(110_000);
    expect(m.margin_pct).toBeCloseTo(110_000 / 120_000);
    expect(m.confidence).toBe(1);
    expect(m.lines.electricity).toEqual({ amount: 8_000, status: "live" });
    expect(m.lines.staff_time?.status).toBe("needs_input");
  });

  it("adds the lines that have a rate and lowers the confidence", () => {
    const m = shadowMargin({ ...base, staffMinutes: 600, params: { hourlyStaffCost: 300, costOfCapitalPct: 18, acquisitionCost: 24_000 } })!;
    expect(m.lines.staff_time).toEqual({ amount: 3_000, status: "part_live" });
    expect(m.lines.acquisition).toEqual({ amount: 2_000, status: "part_live" });
    expect(m.lines.late_payment?.amount).toBe(Math.round(120_000 * 0.18 * (10 / 365)));
    expect(m.variable_cost).toBe(10_000 + 3_000 + 2_000 + m.lines.late_payment!.amount);
    expect(m.confidence).toBeCloseTo(10_000 / m.variable_cost, 4);
  });

  it("keeps fixed costs out: rent share and overhead never enter the stored margin", () => {
    const m = shadowMargin({ ...base, params: { overheadPct: 10, housekeepingPerSeat: 500 } })!;
    expect(m.variable_cost).toBe(10_000);
    expect(Object.keys(m.lines).sort()).toEqual(["acquisition", "concessions", "electricity", "late_payment", "pantry", "staff_time"]);
  });

  it("is null with no seats, no revenue, or unknown seats", () => {
    expect(shadowMargin({ ...base, seats_paid: null })).toBeNull();
    expect(shadowMargin({ ...base, seats_paid: 0 })).toBeNull();
    expect(shadowMargin({ ...base, revenue_ex_gst: 0 })).toBeNull();
  });

  it("does not cost electricity it could not measure, and early payment costs nothing", () => {
    const m = shadowMargin({ ...base, electricityCost: null, avg_days_late: -6, params: { costOfCapitalPct: 18 } })!;
    expect(m.lines.electricity?.status).toBe("needs_input");
    expect(m.lines.late_payment?.amount).toBe(0);
    expect(m.variable_cost).toBe(2_000);
  });

  it("can be negative when the variable costs exceed what the customer pays", () => {
    const m = shadowMargin({ ...base, revenue_ex_gst: 5_000, rent_per_seat: null })!;
    expect(m.margin_after_variable).toBe(-5_000);
  });

  it("has no confidence when nothing at all is costed", () => {
    const m = shadowMargin({ ...base, electricityCost: null, concessions_counted: 0 })!;
    expect(m.variable_cost).toBe(0);
    expect(m.confidence).toBeNull();
  });
});

describe("tenureAt", () => {
  it("counts months from the first contract start, at least one", () => {
    expect(tenureAt("2025-10-19", "2026-09-01")).toBe(12);
    expect(tenureAt("2026-09-10", "2026-09-01")).toBe(1);
    expect(tenureAt("2026-10-01", "2026-09-01")).toBe(1);
    expect(tenureAt(null, "2026-09-01")).toBeNull();
  });
});

describe("summariseShadow", () => {
  const row = (month: string, revenue: number, variable_cost: number, confidence: number | null) => ({ month, revenue, variable_cost, margin_after_variable: revenue - variable_cost, confidence });

  it("is null with no months", () => {
    expect(summariseShadow([])).toBeNull();
  });

  it("weights the margin by revenue and the confidence by variable cost", () => {
    const s = summariseShadow([row("2026-08-01", 100_000, 10_000, 1), row("2026-09-01", 50_000, 30_000, 0.5)])!;
    expect(s.months).toEqual(["2026-08", "2026-09"]);
    expect(s.marginPerMonth).toBe(55_000); // (90,000 + 20,000) / 2
    expect(s.marginPct).toBeCloseTo(110_000 / 150_000);
    expect(s.confidence).toBeCloseTo((1 * 10_000 + 0.5 * 30_000) / 40_000);
  });

  it("has no shadow margin at all when no month had anything costed", () => {
    expect(summariseShadow([row("2026-09-01", 5_000, 0, null)])).toBeNull();
    expect(summariseShadow([row("2026-08-01", 100_000, 0, null), row("2026-09-01", 80_000, 0, null)])).toBeNull();
  });

  it("leaves uncosted months out of the average instead of letting them pull it to 100%", () => {
    const s = summariseShadow([row("2026-07-01", 100_000, 0, null), row("2026-08-01", 100_000, 20_000, 1), row("2026-09-01", 100_000, 40_000, 1)])!;
    expect(s.months).toEqual(["2026-08", "2026-09"]);
    expect(s.marginPct).toBeCloseTo(140_000 / 200_000);
    expect(s.marginPerMonth).toBe(70_000);
  });

  it("shows a negative margin as it is", () => {
    expect(summariseShadow([row("2026-09-01", 5_000, 8_000, 1)])!.marginPct).toBeLessThan(0);
  });
});
