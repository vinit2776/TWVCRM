import { describe, it, expect } from "vitest";
import {
  trailingMonthWindows,
  todayIstDate,
  istDayBounds,
  isAllocationActiveAsOf,
  computeOccupancyByLocation,
  sumSalesInRange,
  allocationOverlapDays,
  daysInRange,
  computeUnitHeatmapStats,
  currentMonthlyRate,
  type SpaceUnitRow,
  type SpaceAllocationRow,
  type ContractRow,
  type SpaceUnitDetailRow,
  type HeatmapAllocationRow,
  type ContractRatePhase,
} from "@/lib/analytics/center-metrics";

describe("trailingMonthWindows", () => {
  it("returns the requested number of windows, oldest first", () => {
    const windows = trailingMonthWindows(6);
    expect(windows).toHaveLength(6);
    const keys = windows.map((w) => w.key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(6);
  });

  it("every window starts on the 1st of its month", () => {
    for (const w of trailingMonthWindows(4)) {
      expect(w.start).toBe(`${w.key}-01`);
    }
  });

  it("clamps the current month's end to today (MTD), not the calendar month-end", () => {
    const windows = trailingMonthWindows(3);
    const current = windows[windows.length - 1];
    expect(current.key).toBe(todayIstDate().slice(0, 7));
    expect(current.end).toBe(todayIstDate());
  });

  it("every non-current window ends on its own natural last calendar day", () => {
    const windows = trailingMonthWindows(6);
    for (const w of windows.slice(0, -1)) {
      const [y, m] = w.key.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      expect(w.end).toBe(`${w.key}-${String(lastDay).padStart(2, "0")}`);
    }
  });
});

describe("istDayBounds", () => {
  it("brackets a whole IST calendar day", () => {
    const { startIso, endIso } = istDayBounds("2026-08-21");
    expect(startIso < endIso).toBe(true);
    expect(startIso).toContain("2026-08-21T00:00:00");
    expect(endIso).toContain("2026-08-21T23:59:59");
  });
});

describe("isAllocationActiveAsOf", () => {
  const base: SpaceAllocationRow = {
    id: "a1", space_unit_id: "u1",
    start_date: "2026-06-01", end_date: null, contract_status: "active",
  };

  it("is occupied once started, with no end date, while the contract is active", () => {
    expect(isAllocationActiveAsOf(base, "2026-08-21")).toBe(true);
    expect(isAllocationActiveAsOf(base, "2026-05-31")).toBe(false);
  });

  it("stops being occupied strictly after end_date", () => {
    const ended = { ...base, end_date: "2026-07-15" };
    expect(isAllocationActiveAsOf(ended, "2026-07-15")).toBe(true); // still occupied on the end date itself
    expect(isAllocationActiveAsOf(ended, "2026-07-16")).toBe(false);
  });

  it("accepts a renewed contract, not just active", () => {
    expect(isAllocationActiveAsOf({ ...base, contract_status: "renewed" }, "2026-08-21")).toBe(true);
  });

  it("doesn't count a within-date allocation whose contract was terminated", () => {
    // The allocation row itself was never closed out, but the contract
    // moved on — this is exactly the data-hygiene gap the contract-status
    // check guards against (see space-analytics/route.ts).
    expect(isAllocationActiveAsOf({ ...base, contract_status: "terminated" }, "2026-08-21")).toBe(false);
  });
});

describe("computeOccupancyByLocation", () => {
  const units: SpaceUnitRow[] = [
    { id: "u1", location_id: "loc1", type: "dedicated_desk", capacity: 10 },
    { id: "u2", location_id: "loc1", type: "private_cabin", capacity: 5 },
    // business_centre is excluded from occupancy_pct — mirrors the existing
    // dashboard occupancy widget (hourly/day-rate, not "seats").
    { id: "u3", location_id: "loc1", type: "business_centre", capacity: 20 },
    { id: "u4", location_id: "loc2", type: "dedicated_desk", capacity: 8 },
  ];

  it("sums capacity per location, excluding business_centre", () => {
    const result = computeOccupancyByLocation(units, [], "2026-08-21");
    expect(result.get("loc1")).toEqual({ capacity: 15, occupied: 0 });
    expect(result.get("loc2")).toEqual({ capacity: 8, occupied: 0 });
  });

  it("counts a unit's full capacity as occupied when it has an active allocation", () => {
    const allocations: SpaceAllocationRow[] = [
      { id: "a1", space_unit_id: "u1", start_date: "2026-06-01", end_date: null, contract_status: "active" },
      { id: "a2", space_unit_id: "u2", start_date: "2026-06-01", end_date: "2026-07-01", contract_status: "active" }, // ended before asOf
      { id: "a3", space_unit_id: "u3", start_date: "2026-06-01", end_date: null, contract_status: "active" }, // business_centre — excluded
    ];
    const result = computeOccupancyByLocation(units, allocations, "2026-08-21");
    // u1's full capacity (10), not a headcount of 1 — an allocation claims the whole unit.
    expect(result.get("loc1")).toEqual({ capacity: 15, occupied: 10 });
  });

  it("clamps occupied at capacity rather than reporting over 100%", () => {
    // Two different (malformed/overlapping) allocations both claiming u1 —
    // still just u1's capacity, not double-counted.
    const overlapping: SpaceAllocationRow[] = [
      { id: "a1", space_unit_id: "u1", start_date: "2026-06-01", end_date: null, contract_status: "active" },
      { id: "a2", space_unit_id: "u1", start_date: "2026-06-01", end_date: null, contract_status: "active" },
    ];
    const result = computeOccupancyByLocation(units, overlapping, "2026-08-21");
    expect(result.get("loc1")!.occupied).toBe(10); // u1's capacity, counted once
  });

  it("ignores an allocation whose unit is inactive/deleted (not in `units`)", () => {
    const orphaned: SpaceAllocationRow[] = [
      { id: "a1", space_unit_id: "u-does-not-exist", start_date: "2026-06-01", end_date: null, contract_status: "active" },
    ];
    const result = computeOccupancyByLocation(units, orphaned, "2026-08-21");
    expect(result.get("loc1")!.occupied).toBe(0);
  });

  it("ignores an allocation whose contract is no longer active/renewed", () => {
    const stale: SpaceAllocationRow[] = [
      { id: "a1", space_unit_id: "u1", start_date: "2026-06-01", end_date: null, contract_status: "terminated" },
    ];
    const result = computeOccupancyByLocation(units, stale, "2026-08-21");
    expect(result.get("loc1")!.occupied).toBe(0);
  });
});

describe("sumSalesInRange", () => {
  const contracts: ContractRow[] = [
    { id: "c1", location_id: "loc1", total_amount: 100, activated_at: "2026-08-05T10:00:00+05:30" },
    { id: "c2", location_id: "loc1", total_amount: 200, activated_at: "2026-07-20T10:00:00+05:30" }, // outside range
    { id: "c3", location_id: "loc2", total_amount: 300, activated_at: "2026-08-10T10:00:00+05:30" }, // other location
    { id: "c4", location_id: "loc1", total_amount: 400, activated_at: null }, // never activated
  ];
  const range = { start: "2026-08-01", end: "2026-08-31" };

  it("sums only activations within range for the given location", () => {
    expect(sumSalesInRange(contracts, range, "loc1")).toBe(100);
  });

  it("sums across all locations when none is given", () => {
    expect(sumSalesInRange(contracts, range)).toBe(400); // c1 + c3
  });

  it("includes an activation on the last instant of the range's end date", () => {
    const edge: ContractRow[] = [
      { id: "edge", location_id: "loc1", total_amount: 50, activated_at: "2026-08-31T23:59:59.999+05:30" },
    ];
    expect(sumSalesInRange(edge, range, "loc1")).toBe(50);
  });

  it("excludes an activation the day after the range ends", () => {
    const edge: ContractRow[] = [
      { id: "edge", location_id: "loc1", total_amount: 50, activated_at: "2026-09-01T00:00:00.000+05:30" },
    ];
    expect(sumSalesInRange(edge, range, "loc1")).toBe(0);
  });
});

describe("daysInRange / allocationOverlapDays", () => {
  it("counts a single day as 1, not 0", () => {
    expect(daysInRange("2026-08-01", "2026-08-01")).toBe(1);
  });

  it("counts a whole month inclusively", () => {
    expect(daysInRange("2026-08-01", "2026-08-31")).toBe(31);
  });

  it("clips an allocation's overlap to the range on both ends", () => {
    // Allocation runs Jul 15 - Aug 10; range is the whole of August.
    const days = allocationOverlapDays({ start_date: "2026-07-15", end_date: "2026-08-10" }, "2026-08-01", "2026-08-31");
    expect(days).toBe(10); // Aug 1-10
  });

  it("treats a null end_date as open-ended, clipped to the range end", () => {
    const days = allocationOverlapDays({ start_date: "2026-08-20", end_date: null }, "2026-08-01", "2026-08-31");
    expect(days).toBe(12); // Aug 20-31
  });

  it("returns 0 when the allocation doesn't overlap the range at all", () => {
    const days = allocationOverlapDays({ start_date: "2026-06-01", end_date: "2026-06-30" }, "2026-08-01", "2026-08-31");
    expect(days).toBe(0);
  });

  it("returns the full range when the allocation spans it entirely", () => {
    const days = allocationOverlapDays({ start_date: "2026-01-01", end_date: null }, "2026-08-01", "2026-08-31");
    expect(days).toBe(31);
  });
});

describe("currentMonthlyRate", () => {
  const phases: ContractRatePhase[] = [
    { phase_order: 1, duration_months: 3, monthly_rate: 10000, end_date: null },
    { phase_order: 2, duration_months: 9, monthly_rate: 12000, end_date: null },
  ];
  const anchor = "2026-01-01"; // phase 1: Jan-Mar, phase 2: Apr-Dec

  it("falls back to the flat amount when the contract has no phases", () => {
    expect(currentMonthlyRate(19145, anchor, undefined, "2026-08-21")).toBe(19145);
    expect(currentMonthlyRate(19145, anchor, [], "2026-08-21")).toBe(19145);
  });

  it("uses the phase covering the given date, not the flat amount", () => {
    expect(currentMonthlyRate(9999, anchor, phases, "2026-02-15")).toBe(10000); // phase 1
    expect(currentMonthlyRate(9999, anchor, phases, "2026-06-15")).toBe(12000); // phase 2
  });

  it("continues flat at the last phase's rate once phases run out", () => {
    // Phases cover Jan-Dec; asking about next February should still be phase 2's rate.
    expect(currentMonthlyRate(9999, anchor, phases, "2027-02-01")).toBe(12000);
  });
});

describe("computeUnitHeatmapStats", () => {
  const units: SpaceUnitDetailRow[] = [
    { id: "u1", location_id: "loc1", type: "private_cabin", capacity: 6, code: "CB-01", name: "Cabin 01" },
    { id: "u2", location_id: "loc1", type: "private_cabin", capacity: 2, code: "CB-02", name: "Cabin 02" },
    { id: "u3", location_id: "loc1", type: "hot_desk", capacity: 1, code: "HD-01", name: "Hot Desk 01" },
  ];
  const range = { start: "2026-08-01", end: "2026-08-31" }; // 31 days
  const today = "2026-08-21";
  const noPhases = new Map<string, ContractRatePhase[]>();

  function alloc(over: Partial<HeatmapAllocationRow>): HeatmapAllocationRow {
    return {
      id: "a", space_unit_id: "u1", contract_id: "c1",
      start_date: "2026-08-01", end_date: null, contract_status: "active",
      // contract_monthly_flat_amount IS the monthly rent already — confirmed
      // against billing.ts, which never divides by tenure_months anywhere.
      contract_monthly_flat_amount: 62000, contract_phase_anchor: "2026-08-01",
      ...over,
    };
  }

  it("computes occupancy_pct as the fraction of the range covered, not a snapshot", () => {
    // 15 of 31 days.
    const allocations = [alloc({ start_date: "2026-08-01", end_date: "2026-08-15" })];
    const stats = computeUnitHeatmapStats(units, allocations, noPhases, range, today);
    const u1 = stats.find((s) => s.unit_id === "u1")!;
    expect(u1.occupancy_pct).toBe(Math.round((15 / 31) * 100));
    // Allocation ended Aug 15, well before "today" (Aug 21) — vacant now,
    // even though it was occupied for part of the queried range.
    expect(u1.vacant_now).toBe(true);
    expect(u1.monthly_revenue).toBe(0);
  });

  it("excludes allocations whose contract is no longer active/renewed from occupancy", () => {
    const allocations = [alloc({ contract_status: "terminated" })];
    const stats = computeUnitHeatmapStats(units, allocations, noPhases, range, today);
    expect(stats.find((s) => s.unit_id === "u1")!.occupancy_pct).toBe(0);
  });

  it("gives a single-unit, flat-rate contract its full monthly amount (not divided by tenure)", () => {
    const allocations = [alloc({ contract_monthly_flat_amount: 62000 })];
    const stats = computeUnitHeatmapStats(units, allocations, noPhases, range, today);
    const u1 = stats.find((s) => s.unit_id === "u1")!;
    expect(u1.monthly_revenue).toBe(62000);
    expect(u1.vacant_now).toBe(false);
    expect(u1.occupancy_pct).toBe(100); // active the whole range, open-ended
  });

  it("uses the contract's current rate phase instead of its flat amount, when it has one", () => {
    const phases = new Map<string, ContractRatePhase[]>([
      ["c1", [
        { phase_order: 1, duration_months: 6, monthly_rate: 15000, end_date: null },
        { phase_order: 2, duration_months: 6, monthly_rate: 18000, end_date: null },
      ]],
    ]);
    // Anchor Jan 1 -> phase 2 (18000) covers Jul-Dec, which includes "today" (Aug 21).
    const allocations = [alloc({ contract_monthly_flat_amount: 9999, contract_phase_anchor: "2026-01-01" })];
    const stats = computeUnitHeatmapStats(units, allocations, phases, range, today);
    expect(stats.find((s) => s.unit_id === "u1")!.monthly_revenue).toBe(18000);
  });

  it("splits a multi-unit contract's rate by capacity share", () => {
    // One contract holds u1 (capacity 6) and u2 (capacity 2) today.
    // Flat monthly rate 80000, total capacity 8 -> u1 gets 6/8, u2 gets 2/8.
    const allocations = [
      alloc({ id: "a1", space_unit_id: "u1", contract_monthly_flat_amount: 80000 }),
      alloc({ id: "a2", space_unit_id: "u2", contract_monthly_flat_amount: 80000 }),
    ];
    const stats = computeUnitHeatmapStats(units, allocations, noPhases, range, today);
    expect(stats.find((s) => s.unit_id === "u1")!.monthly_revenue).toBe(60000); // 80000 * 6/8
    expect(stats.find((s) => s.unit_id === "u2")!.monthly_revenue).toBe(20000); // 80000 * 2/8
  });

  it("marks a unit with no allocations at all as fully vacant", () => {
    const stats = computeUnitHeatmapStats(units, [], noPhases, range, today);
    const u3 = stats.find((s) => s.unit_id === "u3")!;
    expect(u3).toMatchObject({ occupancy_pct: 0, monthly_revenue: 0, vacant_now: true });
  });
});
