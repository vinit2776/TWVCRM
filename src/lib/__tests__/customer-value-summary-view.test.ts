import { describe, it, expect } from "vitest";
import { chartRange } from "@/components/leads/value/score-chart";
import {
  computedAgo,
  confidenceChip,
  isStale,
  monthlySeries,
  pillarHeadline,
  type StoredPillarMethod,
  type StoredScoreRow,
} from "@/lib/customer-value/summary-view";

function row(asOf: string, overall: number | null, tier: StoredScoreRow["tier"] = "B"): StoredScoreRow {
  return {
    as_of: asOf, payment: null, friction: null, engagement: null, profitability: null, confidence: {},
    overall, tier, status: overall === null ? "not_enough_data" : "graded", reason: null, trend_vs_90d: null,
    method: null, story: null, settings_version: "v", computed_at: `${asOf}T00:00:00Z`,
  };
}

describe("monthlySeries", () => {
  it("keeps the last graded score of each month, oldest first", () => {
    const s = monthlySeries([row("2026-08-31", 70), row("2026-09-15", 60), row("2026-09-30", 64), row("2026-10-19", 66)], "2026-10-19");
    expect(s.map((p) => [p.asOf, p.overall])).toEqual([["2026-08-31", 70], ["2026-09-30", 64], ["2026-10-19", 66]]);
  });
  it("skips months that could not be graded", () => {
    const s = monthlySeries([row("2026-08-31", null, null), row("2026-09-30", 64)], "2026-10-19");
    expect(s).toHaveLength(1);
  });
  it("limits to the last twelve months and ignores anything after today", () => {
    // With today in October 2026 the window is November 2025 to October 2026.
    const rows = [row("2025-10-31", 50), row("2025-11-30", 51), row("2026-10-19", 60), row("2026-11-30", 99)];
    expect(monthlySeries(rows, "2026-10-19").map((p) => p.asOf)).toEqual(["2025-11-30", "2026-10-19"]);
  });
  it("is empty with no rows", () => {
    expect(monthlySeries([], "2026-10-19")).toEqual([]);
  });
});

describe("confidenceChip", () => {
  it("says no data when there is no score", () => {
    expect(confidenceChip("payment", null, 0)).toEqual({ label: "No data", tone: "bad" });
  });
  it("flags low confidence below half", () => {
    expect(confidenceChip("friction", 70, 0.4).label).toBe("Low confidence");
  });
  it("always calls revenue health partial", () => {
    expect(confidenceChip("profitability", 90, 1)).toEqual({ label: "Partial", tone: "warn" });
  });
  it("separates full from some data missing", () => {
    expect(confidenceChip("payment", 80, 1).label).toBe("Full data");
    expect(confidenceChip("payment", 80, 0.7).label).toBe("Some gaps");
  });
});

const method = (metrics: StoredPillarMethod["metrics"], notes: string[] = []): StoredPillarMethod => ({ notes, months_used: 6, metrics });
const m = (key: string, score: number | null, status: "ok" | "missing" | "na" = "ok") => ({ key, status, method: "fixed", cohort_size: 0, value: 1, score });

describe("pillarHeadline", () => {
  it("names the weakest measured metric", () => {
    expect(pillarHeadline(method([m("avg_days_late", 20), m("on_time_share", 80)]), 50)).toBe("Weakest: days late (20)");
  });
  it("says nothing is weighing a pillar down when everything is strong", () => {
    expect(pillarHeadline(method([m("avg_days_late", 95), m("on_time_share", 100)]), 97)).toBe("Nothing weighing this down");
  });
  it("ignores metrics that were not measured", () => {
    expect(pillarHeadline(method([m("avg_days_late", null, "missing"), m("on_time_share", 60)]), 60)).toBe("Weakest: on-time share (60)");
  });
  it("falls back to the caveat, then to a plain message, when nothing was measured", () => {
    expect(pillarHeadline(method([m("avg_days_late", null, "missing")], ["No invoices in the scoring window"]), null)).toBe("No invoices in the scoring window");
    expect(pillarHeadline(undefined, null)).toBe("Not enough data yet");
  });
});

describe("freshness", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  it("words the age", () => {
    expect(computedAgo("2026-10-19T11:50:00Z", now)).toBe("Computed just now");
    expect(computedAgo("2026-10-19T09:00:00Z", now)).toBe("Computed 3 hours ago");
    expect(computedAgo("2026-10-18T11:00:00Z", now)).toBe("Computed 1 day ago");
    expect(computedAgo("2026-10-15T12:00:00Z", now)).toBe("Computed 4 days ago");
    expect(computedAgo("garbage", now)).toMatch(/unknown/);
  });
  it("calls a score stale after a day and a half", () => {
    expect(isStale("2026-10-18T12:00:00Z", now)).toBe(false);
    expect(isStale("2026-10-17T23:00:00Z", now)).toBe(true);
    expect(isStale("garbage", now)).toBe(false);
  });
});

describe("chartRange", () => {
  it("zooms in on the data instead of always spanning 0 to 100", () => {
    expect(chartRange([64, 65, 63])).toEqual({ lo: 50, hi: 80 });
  });
  it("is never shorter than 30 points", () => {
    const { lo, hi } = chartRange([50, 50]);
    expect(hi - lo).toBeGreaterThanOrEqual(30);
  });
  it("stays inside 0 to 100 at both ends", () => {
    expect(chartRange([95, 99]).hi).toBe(100);
    expect(chartRange([2, 5]).lo).toBe(0);
    const high = chartRange([95, 99]);
    expect(high.hi - high.lo).toBeGreaterThanOrEqual(30);
  });
  it("copes with a single value", () => {
    const { lo, hi } = chartRange([72]);
    expect(lo).toBeLessThanOrEqual(72);
    expect(hi).toBeGreaterThanOrEqual(72);
  });
});
