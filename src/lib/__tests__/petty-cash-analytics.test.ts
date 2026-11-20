import { describe, it, expect } from "vitest";
import { aggregatePettyCash, entriesToCsv, weekStart, type AnalyticsRow } from "../petty-cash-analytics";

const row = (over: Partial<AnalyticsRow>): AnalyticsRow => ({
  entry_number: "PCE-1",
  date: "2026-11-18",
  amount: 100,
  description: "x",
  category_id: "c1",
  category: "Food",
  person_id: "p1",
  person: "Meena",
  location_id: "l1",
  location: "Perungudi",
  ...over,
});

describe("aggregatePettyCash", () => {
  it("counts every row, not a page of 50", () => {
    const rows = Array.from({ length: 120 }, () => row({ amount: 10 }));
    const a = aggregatePettyCash(rows);
    expect(a.count).toBe(120);
    expect(a.totalSpend).toBe(1200);
    expect(a.average).toBe(10);
  });

  it("groups by category, person and location, largest first", () => {
    const a = aggregatePettyCash([
      row({ amount: 100 }),
      row({ amount: 400, category_id: "c2", category: "Travel", person_id: "p2", person: "Ravi", location_id: null, location: null }),
    ]);
    expect(a.byCategory.map((c) => c.name)).toEqual(["Travel", "Food"]);
    expect(a.byPerson[0]).toMatchObject({ name: "Ravi", total: 400, count: 1 });
    expect(a.byLocation[0].name).toBe("No location");
  });

  it("labels expenses without a category as Uncategorized", () => {
    const a = aggregatePettyCash([row({ category_id: null, category: null })]);
    expect(a.byCategory[0].name).toBe("Uncategorized");
  });

  it("buckets weeks starting Monday, in order", () => {
    // 2026-11-16 is a Monday; 11-22 is the Sunday of that week
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    const a = aggregatePettyCash([row({ date: "2026-11-23", amount: 5 }), row({ date: "2026-11-17", amount: 7 }), row({ date: "2026-11-22", amount: 3 })]);
    expect(a.byWeek).toEqual([
      { weekStart: "2026-11-16", total: 10, count: 2 },
      { weekStart: "2026-11-23", total: 5, count: 1 },
    ]);
  });

  it("handles no rows", () => {
    const a = aggregatePettyCash([]);
    expect(a).toMatchObject({ totalSpend: 0, count: 0, average: 0, byWeek: [] });
  });
});

describe("entriesToCsv", () => {
  it("quotes commas and neutralises formula-looking text", () => {
    const csv = entriesToCsv([row({ description: '=HYPERLINK("x"), tea' })]);
    expect(csv.split("\n")[1]).toContain(`"'=HYPERLINK(""x""), tea"`);
  });
});
