import { describe, expect, it } from "vitest";
import { comparePreview } from "@/lib/customer-value/margin-preview";
import { scoreProfitability, type MarginPoint, type MonthlyMetrics } from "@/lib/customer-value/scoring-pillars";
import { DEFAULT_SCORING_SETTINGS, mergeSettings } from "@/lib/customer-value/scoring-settings";
import type { CustomerScore } from "@/lib/customer-value/scoring-overall";

const ASOF = "2026-10-19";
const row = (month: string): MonthlyMetrics => ({
  month, revenue_ex_gst: 100_000, invoiced_count: 1, avg_days_late: 0, measured_count: 1, on_time_count: 1, overdue_amount: 0, max_days_overdue: 0,
  reminders: 0, concessions_counted: 0, seats_paid: 10, seats_used_avg: null, rent_per_seat: 10_000, tickets_linked: 0, tickets_sla_breached: 0,
  tickets_reopened: 0, satisfaction_avg: null, satisfaction_count: 0, bookings: 0, billing_queries: null,
});
const months = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"];
const rows = months.map(row);
const margin = (pct: number): MarginPoint[] => months.map((m) => ({ month: m, revenue: 100_000, margin_after_variable: 100_000 * pct }));
const on = mergeSettings({ metricWeights: { ...DEFAULT_SCORING_SETTINGS.metricWeights, margin_after_variable_pct: 50 } });

describe("margin in Profitability", () => {
  it("is off by default: the pillar is exactly what it was, with or without margin data", () => {
    const without = scoreProfitability(rows, ASOF, DEFAULT_SCORING_SETTINGS, {}, {});
    const withData = scoreProfitability(rows, ASOF, DEFAULT_SCORING_SETTINGS, {}, { margin: margin(0.5) });
    expect(withData).toEqual(without);
    expect(without.metrics.some((m) => m.key === "margin_after_variable_pct")).toBe(false);
    expect(without.notes[0]).toMatch(/Revenue side only/);
  });

  it("adds a scored metric when given a weight, and a better margin scores higher", () => {
    const good = scoreProfitability(rows, ASOF, on, {}, { margin: margin(0.9) });
    const poor = scoreProfitability(rows, ASOF, on, {}, { margin: margin(0.3) });
    const gm = good.metrics.find((m) => m.key === "margin_after_variable_pct")!;
    const pm = poor.metrics.find((m) => m.key === "margin_after_variable_pct")!;
    expect(gm.status).toBe("ok");
    expect(gm.value).toBeCloseTo(0.9);
    expect(gm.score).toBeCloseTo(100);
    expect(pm.score).toBeCloseTo(0);
    expect(good.score!).toBeGreaterThan(poor.score!);
    expect(good.notes[0]).toMatch(/margin after variable costs/);
  });

  it("is not applicable, not missing, when there is no stored margin", () => {
    const r = scoreProfitability(rows, ASOF, on, {}, {});
    const m = r.metrics.find((x) => x.key === "margin_after_variable_pct")!;
    expect(m.status).toBe("na");
    const off = scoreProfitability(rows, ASOF, DEFAULT_SCORING_SETTINGS, {}, {});
    expect(r.confidence).toBeCloseTo(off.confidence);
  });

  it("weights months by revenue and ignores months after the date", () => {
    const pts: MarginPoint[] = [
      { month: "2026-08-01", revenue: 100_000, margin_after_variable: 90_000 },
      { month: "2026-09-01", revenue: 1_000, margin_after_variable: -500 },
      { month: "2026-12-01", revenue: 500_000, margin_after_variable: -400_000 },
    ];
    const m = scoreProfitability(rows, ASOF, on, {}, { margin: pts }).metrics.find((x) => x.key === "margin_after_variable_pct")!;
    expect(m.value!).toBeGreaterThan(0.8);
  });

  it("ranks against the center's customers by percentile when the cohort is large enough", () => {
    const cohort = { margin_after_variable_pct: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.88] };
    const m = scoreProfitability(rows, ASOF, on, cohort, { margin: margin(0.95) }).metrics.find((x) => x.key === "margin_after_variable_pct")!;
    expect(m.method).toBe("percentile");
    expect(m.score).toBe(100);
  });
});

describe("comparePreview", () => {
  const score = (tier: CustomerScore["tier"], overall: number | null, prof: number | null) =>
    ({ tier, overall, pillars: { profitability: { score: prof } } }) as unknown as CustomerScore;

  it("counts tier moves in each direction and ignores customers whose tier does not change", () => {
    const base = new Map([["a", score("B", 70, 60)], ["b", score("C", 50, 50)], ["c", score("A", 80, 80)], ["d", score(null, null, null)], ["e", score("B", 65, 60)]]);
    const trial = new Map([["a", score("A", 76, 90)], ["b", score("D", 38, 20)], ["c", score("A", 82, 90)], ["d", score("C", 45, 45)], ["e", score(null, null, 40)]]);
    const r = comparePreview(base, trial);
    expect(r.counts).toEqual({ unchanged: 1, up: 1, down: 1, gainedTier: 1, lostTier: 1 });
    expect(r.profitabilityChanged).toBe(5);
    expect(r.tierChanges.map((c) => c.leadId).sort()).toEqual(["a", "b", "d", "e"]);
  });

  it("reports nothing when nothing changes", () => {
    const same = new Map([["a", score("B", 70, 60)]]);
    expect(comparePreview(same, same)).toEqual({ tierChanges: [], counts: { unchanged: 1, up: 0, down: 0, gainedTier: 0, lostTier: 0 }, profitabilityChanged: 0 });
  });
});
