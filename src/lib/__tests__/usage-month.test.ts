import { describe, it, expect } from "vitest";
import { lastMonths, pickerOptions, chargeDateForMonth, monthNamedIn, usageMonthHint, monthKeyOf } from "../usage-month";

describe("lastMonths", () => {
  it("lists six months, current first, across a year boundary", () => {
    expect(lastMonths("2026-02-10").map((o) => o.key)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11", "2025-10", "2025-09"]);
    expect(lastMonths("2026-10-15")[1].label).toBe("September 2026");
  });
});

describe("pickerOptions", () => {
  it("hides locked months", () => {
    const keys = pickerOptions("2026-10-15", new Set(["2026-08", "2026-07"])).map((o) => o.key);
    expect(keys).toEqual(["2026-10", "2026-09", "2026-06", "2026-05"]);
  });
  it("keeps the selected month even if locked or outside the window", () => {
    const keys = pickerOptions("2026-10-15", new Set(["2026-08"]), "2026-08").map((o) => o.key);
    expect(keys).toContain("2026-08");
    const old = pickerOptions("2026-10-15", new Set(), "2026-01").map((o) => o.key);
    expect(old[old.length - 1]).toBe("2026-01");
  });
});

describe("chargeDateForMonth", () => {
  it("uses the last day for a past month, today for the current month", () => {
    expect(chargeDateForMonth("2026-09", "2026-10-15")).toBe("2026-09-30");
    expect(chargeDateForMonth("2026-02", "2026-10-15")).toBe("2026-02-28");
    expect(chargeDateForMonth("2028-02", "2028-03-01")).toBe("2028-02-29");
    expect(chargeDateForMonth("2026-10", "2026-10-15")).toBe("2026-10-15");
  });
  it("keeps the existing date when the month is unchanged", () => {
    expect(chargeDateForMonth("2026-09", "2026-10-15", "2026-09-12")).toBe("2026-09-12");
    expect(monthKeyOf("2026-09-12")).toBe("2026-09");
  });
});

describe("monthNamedIn", () => {
  it("finds the month in the descriptions that caused the October mix-up", () => {
    expect(monthNamedIn("Print out charge -Sep month", "2026-10-14")).toBe("2026-09");
    expect(monthNamedIn("Color print services for September", "2026-10-14")).toBe("2026-09");
    expect(monthNamedIn("Colour print, September 2026: 44 pages", "2026-10-14")).toBe("2026-09");
  });
  it("rolls back a year when the named month is later in the calendar year", () => {
    expect(monthNamedIn("Dec usage", "2027-01-05")).toBe("2026-12");
  });
  it("returns null for none or several months, and ignores 'may' as a word only", () => {
    expect(monthNamedIn("Extra chairs", "2026-10-14")).toBeNull();
    expect(monthNamedIn("Print Sep and Aug", "2026-10-14")).toBeNull();
    expect(monthNamedIn("Autumn print", "2026-10-14")).toBeNull();
    expect(monthNamedIn("Extra chairs may be billed", "2026-10-14")).toBeNull();
    expect(monthNamedIn("May be added later", "2026-10-14")).toBeNull();
    expect(monthNamedIn("Print usage for May", "2026-10-14")).toBe("2026-05");
  });
});

describe("usageMonthHint", () => {
  it("says when a current-month charge can be sent", () => {
    expect(usageMonthHint("2026-10", "2026-10-15")).toContain("once the month ends");
    expect(usageMonthHint("2026-09", "2026-10-15")).toBe("Goes on the September 2026 invoice. The invoice is dated the day you send it.");
  });
});
