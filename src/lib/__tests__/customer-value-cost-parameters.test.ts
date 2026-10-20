import { describe, expect, it } from "vitest";
import { COST_PARAMETER_DEFS, costParameterWriteSchema, inForce, resolveParams, type CostParameterRow } from "@/lib/customer-value/cost-parameters";

const LOC = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
let n = 0;
const row = (over: Partial<CostParameterRow>): CostParameterRow => ({
  id: `r${++n}`, scope: "global", location_id: null, lead_id: null, key: "hourly_staff_cost", value: 300,
  effective_from: "2026-01-01", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, ...over,
});

describe("inForce", () => {
  it("uses the latest row on or before the month and ignores later ones", () => {
    const rows = [row({ value: 250, effective_from: "2026-01-01" }), row({ value: 300, effective_from: "2026-07-01" }), row({ value: 999, effective_from: "2026-12-01" })];
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2026-06-15")?.value).toBe(250);
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2026-07-01")?.value).toBe(300);
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2025-12-31")).toBeNull();
  });

  it("gives a same-day correction to the row created later", () => {
    const rows = [row({ value: 250, effective_from: "2026-03-01" }), row({ value: 275, effective_from: "2026-03-01" })];
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2026-04-01")?.value).toBe(275);
  });

  it("treats a cleared row as nothing in force from its date", () => {
    const rows = [row({ value: 300, effective_from: "2026-01-01" }), row({ value: null, effective_from: "2026-06-01" })];
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2026-05-31")?.value).toBe(300);
    expect(inForce(rows, "global", {}, "hourly_staff_cost", "2026-06-01")).toBeNull();
  });

  it("keeps centers and customers apart", () => {
    const rows = [row({ scope: "location", location_id: LOC, value: 400 })];
    expect(inForce(rows, "location", { locationId: LOC }, "hourly_staff_cost", "2026-06-01")?.value).toBe(400);
    expect(inForce(rows, "location", { locationId: "other" }, "hourly_staff_cost", "2026-06-01")).toBeNull();
  });
});

describe("resolveParams", () => {
  const rows = [
    row({ value: 300 }),
    row({ scope: "location", location_id: LOC, value: 400 }),
    row({ scope: "lead", lead_id: LEAD, value: 500 }),
    row({ key: "housekeeping_per_seat", value: 600 }),
    row({ key: "cost_of_capital_pct", scope: "location", location_id: LOC, value: 12 }),
  ];

  it("prefers the customer value, then the center's, then the global one", () => {
    expect(resolveParams(rows, { leadId: LEAD, locationId: LOC, asOf: "2026-06-01" }).params.hourlyStaffCost).toBe(500);
    expect(resolveParams(rows, { leadId: "x", locationId: LOC, asOf: "2026-06-01" }).params.hourlyStaffCost).toBe(400);
    expect(resolveParams(rows, { leadId: "x", locationId: "y", asOf: "2026-06-01" }).params.hourlyStaffCost).toBe(300);
  });

  it("reports where each value came from and leaves unset values out entirely", () => {
    const r = resolveParams(rows, { leadId: LEAD, locationId: LOC, asOf: "2026-06-01" });
    expect(r.sources.hourlyStaffCost).toEqual({ scope: "lead", effective_from: "2026-01-01" });
    expect(r.sources.housekeepingPerSeat?.scope).toBe("global");
    expect(r.sources.costOfCapitalPct?.scope).toBe("location");
    expect("overheadPct" in r.params).toBe(false);
  });

  it("falls back to the center value when a customer override is cleared", () => {
    const withClear = [...rows, row({ scope: "lead", lead_id: LEAD, value: null, effective_from: "2026-06-01" })];
    expect(resolveParams(withClear, { leadId: LEAD, locationId: LOC, asOf: "2026-06-01" }).params.hourlyStaffCost).toBe(400);
    expect(resolveParams(withClear, { leadId: LEAD, locationId: LOC, asOf: "2026-05-01" }).params.hourlyStaffCost).toBe(500);
  });

  it("is empty with no rows: nothing is ever assumed", () => {
    expect(resolveParams([], { leadId: LEAD, locationId: LOC, asOf: "2026-06-01" }).params).toEqual({});
  });
});

describe("costParameterWriteSchema", () => {
  const ok = { scope: "global", key: "hourly_staff_cost", value: 300, effective_from: "2026-10-01" };

  it("accepts a global value, a center value and a clear", () => {
    expect(costParameterWriteSchema.safeParse(ok).success).toBe(true);
    expect(costParameterWriteSchema.safeParse({ ...ok, scope: "location", location_id: LOC }).success).toBe(true);
    expect(costParameterWriteSchema.safeParse({ ...ok, scope: "lead", lead_id: LEAD, value: null }).success).toBe(true);
  });

  it("requires the id that matches the scope and rejects the wrong one", () => {
    expect(costParameterWriteSchema.safeParse({ ...ok, scope: "location" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, scope: "global", location_id: LOC }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, scope: "lead", lead_id: LEAD, location_id: LOC }).success).toBe(false);
  });

  it("rejects negative, over-ceiling and non-numeric values, and unknown keys or fields", () => {
    expect(costParameterWriteSchema.safeParse({ ...ok, value: -1 }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, key: "cost_of_capital_pct", value: 101 }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, value: "300" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, key: "made_up" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("rejects dates that are malformed, ancient or far in the future", () => {
    expect(costParameterWriteSchema.safeParse({ ...ok, effective_from: "1 Oct 2026" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, effective_from: "2019-12-31" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, effective_from: "2099-01-01" }).success).toBe(false);
    expect(costParameterWriteSchema.safeParse({ ...ok, effective_from: "2026-13-45" }).success).toBe(false);
  });
});

describe("definitions", () => {
  it("cover every simulator input exactly once", () => {
    const params = COST_PARAMETER_DEFS.map((d) => d.param);
    expect(new Set(params).size).toBe(params.length);
    expect(params).toHaveLength(9);
  });
});
