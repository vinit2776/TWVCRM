import { describe, it, expect } from "vitest";
import { cycleMonthWindows } from "../billing";

/**
 * cycleMonthWindows drives advance (quarterly / half-yearly / yearly) rent
 * billing: one window per calendar month of the cycle, each carrying its own
 * days-in-month so rent is prorated against the right denominator instead of
 * a flat "cycleMonths × monthly rate".
 */
describe("cycleMonthWindows", () => {
  it("monthly contracts get exactly one window — today's behaviour, unchanged", () => {
    const w = cycleMonthWindows(9, 2026, 1);
    expect(w).toHaveLength(1);
    expect(w[0]).toEqual({ month: 9, year: 2026, first: "2026-09-01", last: "2026-09-30", days: 30 });
  });

  it("a quarter starting Sep 2026 covers Sep, Oct, Nov with correct month lengths", () => {
    const w = cycleMonthWindows(9, 2026, 3);
    expect(w.map((x) => x.first)).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(w.map((x) => x.last)).toEqual(["2026-09-30", "2026-10-31", "2026-11-30"]);
    expect(w.map((x) => x.days)).toEqual([30, 31, 30]);
  });

  it("wraps the year mid-cycle", () => {
    const w = cycleMonthWindows(11, 2026, 3);
    expect(w.map((x) => `${x.year}-${x.month}`)).toEqual(["2026-11", "2026-12", "2027-1"]);
    expect(w[2].last).toBe("2027-01-31");
  });

  it("a yearly cycle returns 12 windows ending in the same month a year on", () => {
    const w = cycleMonthWindows(4, 2026, 12);
    expect(w).toHaveLength(12);
    expect(w[0].first).toBe("2026-04-01");
    expect(w[11].last).toBe("2027-03-31");
  });

  it("February is 29 days in a leap year, 28 otherwise", () => {
    expect(cycleMonthWindows(2, 2028, 1)[0].days).toBe(29);
    expect(cycleMonthWindows(2, 2027, 1)[0].days).toBe(28);
  });

  it("a half-yearly cycle spanning a leap February keeps that month at 29 days", () => {
    const w = cycleMonthWindows(12, 2027, 6);
    const feb = w.find((x) => x.month === 2 && x.year === 2028);
    expect(feb?.days).toBe(29);
    expect(w[5].last).toBe("2028-05-31");
  });

  it("windows are contiguous — no gap or overlap between consecutive months", () => {
    const w = cycleMonthWindows(1, 2026, 12);
    for (let i = 1; i < w.length; i++) {
      const prevLast = new Date(w[i - 1].last + "T00:00:00Z");
      const thisFirst = new Date(w[i].first + "T00:00:00Z");
      expect((thisFirst.getTime() - prevLast.getTime()) / 86400000).toBe(1);
    }
  });
});
