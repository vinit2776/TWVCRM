import { describe, it, expect } from "vitest";
import {
  countCeiling,
  daysRange,
  daysToPayPoints,
  monthlyInRange,
  pillarSeries,
  seatPoints,
  ticketPoints,
  type PerfMonthRow,
  type PerfScoreRow,
} from "@/lib/customer-value/performance-view";

const TODAY = "2026-10-19";

function score(asOf: string, over: Partial<PerfScoreRow> = {}): PerfScoreRow {
  return { as_of: asOf, payment: 80, friction: 90, engagement: 70, profitability: 60, overall: 75, tier: "A", status: "graded", ...over };
}
function month(m: string, over: Partial<PerfMonthRow> = {}): PerfMonthRow {
  return {
    month: m, avg_days_late: null, measured_count: 0, on_time_count: 0, seats_paid: 10, seats_used_avg: null,
    tickets_linked: 0, tickets_unlinked: 0, tickets_sla_breached: 0, data_flags: null, ...over,
  };
}

describe("pillarSeries", () => {
  it("keeps the last score of each month, oldest first", () => {
    const s = pillarSeries([score("2026-09-15", { payment: 50 }), score("2026-09-30", { payment: 60 }), score("2026-08-31")], TODAY, "all");
    expect(s.map((p) => [p.asOf, p.payment])).toEqual([["2026-08-31", 80], ["2026-09-30", 60]]);
  });
  it("applies the range from today's month", () => {
    const rows = ["2026-03-31", "2026-04-30", "2026-05-31", "2026-10-19"].map((d) => score(d));
    expect(pillarSeries(rows, TODAY, "6").map((p) => p.asOf)).toEqual(["2026-05-31", "2026-10-19"]);
    expect(pillarSeries(rows, TODAY, "12")).toHaveLength(4);
    expect(pillarSeries(rows, TODAY, "all")).toHaveLength(4);
  });
  it("ignores dates after today", () => {
    expect(pillarSeries([score("2026-11-30")], TODAY, "all")).toEqual([]);
  });
  it("keeps ungraded months that still have pillar values, and skips months with none", () => {
    const rows = [score("2026-08-31", { status: "not_enough_data", overall: null, tier: null }), score("2026-09-30", { payment: null, friction: null, engagement: null, profitability: null, overall: null })];
    const s = pillarSeries(rows, TODAY, "all");
    expect(s).toHaveLength(1);
    expect(s[0].overall).toBeNull();
  });
  it("leaves a pillar that could not be scored as a gap (null), not zero", () => {
    expect(pillarSeries([score("2026-09-30", { friction: null })], TODAY, "all")[0].friction).toBeNull();
  });
});

describe("monthlyInRange", () => {
  const rows = ["2026-02-01", "2026-05-01", "2026-09-01", "2026-10-01"].map((m) => month(m));
  it("slices without refetching", () => {
    expect(monthlyInRange(rows, TODAY, "6").map((r) => r.month)).toEqual(["2026-05-01", "2026-09-01", "2026-10-01"]);
    expect(monthlyInRange(rows, TODAY, "all")).toHaveLength(4);
  });
  it("sorts oldest first", () => {
    expect(monthlyInRange([month("2026-10-01"), month("2026-09-01")], TODAY, "all").map((r) => r.month)).toEqual(["2026-09-01", "2026-10-01"]);
  });
});

describe("daysToPayPoints", () => {
  it("is a gap, not zero, for a month with nothing timed", () => {
    expect(daysToPayPoints([month("2026-09-01", { measured_count: 0, avg_days_late: null })])[0].days).toBeNull();
  });
  it("keeps early as negative and carries the counts", () => {
    expect(daysToPayPoints([month("2026-09-01", { measured_count: 3, on_time_count: 2, avg_days_late: -1.67 })])[0]).toEqual({ month: "2026-09-01", days: -1.67, invoices: 3, onTime: 2 });
  });
  it("treats a zero-days average as a real zero when invoices were timed", () => {
    expect(daysToPayPoints([month("2026-09-01", { measured_count: 2, on_time_count: 2, avg_days_late: 0 })])[0].days).toBe(0);
  });
});

describe("seatPoints and ticketPoints", () => {
  it("says whether any usage data exists", () => {
    expect(seatPoints([month("2026-09-01")]).hasUsage).toBe(false);
    expect(seatPoints([month("2026-09-01"), month("2026-10-01", { seats_used_avg: 6 })]).hasUsage).toBe(true);
  });
  it("totals tickets and the ones that could not be attributed", () => {
    const t = ticketPoints([month("2026-09-01", { tickets_linked: 2, tickets_unlinked: 1, tickets_sla_breached: 1 }), month("2026-10-01", { tickets_linked: 3, tickets_unlinked: 4 })]);
    expect(t.total).toBe(5);
    expect(t.unlinkedTotal).toBe(5);
    expect(t.points[0].breached).toBe(1);
  });
});

describe("axis helpers", () => {
  it("shows early and late payment on one axis", () => {
    expect(daysRange([-6, 3])).toEqual({ lo: -6, hi: 5 });
    expect(daysRange([12.2])).toEqual({ lo: -2, hi: 13 });
    expect(daysRange([])).toEqual({ lo: -2, hi: 5 });
  });
  it("picks a tidy count ceiling", () => {
    expect(countCeiling([1, 2])).toBe(4);
    expect(countCeiling([7])).toBe(7);
    expect(countCeiling([12])).toBe(15);
    expect(countCeiling([])).toBe(4);
  });
});
