import { describe, it, expect } from "vitest";
import {
  trailingMonthWindows,
  todayIstDate,
  istDayBounds,
  isOccupiedAsOf,
  computeOccupancyByLocation,
  sumSalesInRange,
  type SpaceUnitRow,
  type SeatOccupantRow,
  type ContractRow,
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

describe("isOccupiedAsOf", () => {
  const base: SeatOccupantRow = {
    id: "o1", location_id: "loc1", space_unit_id: "u1",
    start_date: "2026-06-01", end_date: null,
  };

  it("is occupied once started, with no end date", () => {
    expect(isOccupiedAsOf(base, "2026-08-21")).toBe(true);
    expect(isOccupiedAsOf(base, "2026-05-31")).toBe(false);
  });

  it("stops being occupied strictly after end_date", () => {
    const ended = { ...base, end_date: "2026-07-15" };
    expect(isOccupiedAsOf(ended, "2026-07-15")).toBe(true); // still occupied on the end date itself
    expect(isOccupiedAsOf(ended, "2026-07-16")).toBe(false);
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

  it("counts only seats active as of the given date", () => {
    const occupants: SeatOccupantRow[] = [
      { id: "o1", location_id: "loc1", space_unit_id: "u1", start_date: "2026-06-01", end_date: null },
      { id: "o2", location_id: "loc1", space_unit_id: "u2", start_date: "2026-06-01", end_date: "2026-07-01" }, // ended before asOf
      { id: "o3", location_id: "loc1", space_unit_id: "u3", start_date: "2026-06-01", end_date: null }, // business_centre — excluded
    ];
    const result = computeOccupancyByLocation(units, occupants, "2026-08-21");
    expect(result.get("loc1")).toEqual({ capacity: 15, occupied: 1 });
  });

  it("clamps occupied at capacity rather than reporting over 100%", () => {
    const crowded: SeatOccupantRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `o${i}`, location_id: "loc1", space_unit_id: "u1", start_date: "2026-06-01", end_date: null,
    }));
    const result = computeOccupancyByLocation(units, crowded, "2026-08-21");
    expect(result.get("loc1")!.occupied).toBe(15); // clamped, not 20
  });

  it("ignores a seat whose unit is inactive/deleted (not in `units`)", () => {
    const orphaned: SeatOccupantRow[] = [
      { id: "o1", location_id: "loc1", space_unit_id: "u-does-not-exist", start_date: "2026-06-01", end_date: null },
    ];
    const result = computeOccupancyByLocation(units, orphaned, "2026-08-21");
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
