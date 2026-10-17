import { describe, it, expect } from "vitest";
import {
  clamp,
  combineMetrics,
  linearScale,
  missingMetric,
  monthIndex,
  monthsBetween,
  notApplicableMetric,
  percentileScore,
  piecewiseScale,
  recencyWeight,
  ruleMetric,
  scoreMetric,
  selectWindow,
  weightedMean,
  type MetricResult,
} from "@/lib/customer-value/scoring-primitives";
import {
  DEFAULT_SCORING_SETTINGS,
  mergeSettings,
  validateSettings,
  type ScoringSettings,
} from "@/lib/customer-value/scoring-settings";

describe("clamp", () => {
  it("limits a number to a range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("linearScale", () => {
  const lowerIsBetter = { best: 0, worst: 15 };
  const higherIsBetter = { best: 1, worst: 0.4 };

  it("maps best to 100 and worst to 0", () => {
    expect(linearScale(0, lowerIsBetter)).toBe(100);
    expect(linearScale(15, lowerIsBetter)).toBe(0);
    expect(linearScale(7.5, lowerIsBetter)).toBe(50);
  });
  it("clamps beyond either end", () => {
    expect(linearScale(-3, lowerIsBetter)).toBe(100);
    expect(linearScale(40, lowerIsBetter)).toBe(0);
  });
  it("works when best is the larger number", () => {
    expect(linearScale(1, higherIsBetter)).toBe(100);
    expect(linearScale(0.7, higherIsBetter)).toBeCloseTo(50, 5);
    expect(linearScale(0.4, higherIsBetter)).toBe(0);
    expect(linearScale(0.2, higherIsBetter)).toBe(0);
  });
  it("returns 100 for a degenerate scale instead of dividing by zero", () => {
    expect(linearScale(3, { best: 5, worst: 5 })).toBe(100);
  });
});

describe("piecewiseScale", () => {
  const points: Array<[number, number]> = [
    [-25, 0],
    [0, 60],
    [10, 100],
  ];
  it("is flat beyond the first and last point", () => {
    expect(piecewiseScale(-50, points)).toBe(0);
    expect(piecewiseScale(30, points)).toBe(100);
  });
  it("hits the points exactly", () => {
    expect(piecewiseScale(-25, points)).toBe(0);
    expect(piecewiseScale(0, points)).toBe(60);
    expect(piecewiseScale(10, points)).toBe(100);
  });
  it("interpolates between points", () => {
    expect(piecewiseScale(-12.5, points)).toBeCloseTo(30, 5);
    expect(piecewiseScale(5, points)).toBeCloseTo(80, 5);
  });
  it("does not depend on the order the points were given in", () => {
    expect(piecewiseScale(5, [...points].reverse())).toBeCloseTo(80, 5);
  });
  it("scores nothing for no points", () => {
    expect(piecewiseScale(1, [])).toBe(0);
  });
});

describe("percentileScore", () => {
  const cohort = [1, 2, 3, 4];
  it("is 100 when better than everyone and 0 when worse than everyone", () => {
    expect(percentileScore(5, cohort, true)).toBe(100);
    expect(percentileScore(0, cohort, true)).toBe(0);
  });
  it("ranks between", () => {
    expect(percentileScore(2.5, cohort, true)).toBe(50);
  });
  it("flips for metrics where lower is better", () => {
    expect(percentileScore(0, cohort, false)).toBe(100);
    expect(percentileScore(5, cohort, false)).toBe(0);
  });
  it("counts a tie as half", () => {
    expect(percentileScore(2, [2, 2], true)).toBe(50);
    expect(percentileScore(2, [1, 2, 3], true)).toBeCloseTo(50, 5);
  });
  it("is null for an empty cohort and ignores values that are not numbers", () => {
    expect(percentileScore(1, [], true)).toBeNull();
    expect(percentileScore(1, [Number.NaN, Infinity], true)).toBeNull();
    expect(percentileScore(5, [1, Number.NaN, 3], true)).toBe(100);
  });
});

describe("time helpers", () => {
  it("counts months between two dates, either format", () => {
    expect(monthsBetween("2026-04-01", "2026-10-01")).toBe(6);
    expect(monthsBetween("2026-10", "2026-04")).toBe(-6);
    expect(monthIndex("2026-01-15")).toBe(monthIndex("2026-01-01"));
  });
  it("halves the weight every half-life", () => {
    expect(recencyWeight(0, 3)).toBe(1);
    expect(recencyWeight(3, 3)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(6, 3)).toBeCloseTo(0.25, 10);
    expect(recencyWeight(-2, 3)).toBe(1);
  });
});

describe("selectWindow", () => {
  const rows = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"].map(
    (month) => ({ month })
  );

  it("keeps the window's months, newest first, and drops older and later ones", () => {
    const win = selectWindow(rows, "2026-10-01", 6, 3);
    expect(win.map((w) => w.row.month)).toEqual([
      "2026-10-01",
      "2026-09-01",
      "2026-08-01",
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
    ]);
    expect(win.map((w) => w.monthsAgo)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("never sees a month after asOf, so a past score cannot know the future", () => {
    const win = selectWindow(rows, "2026-06-01", 6, 3);
    expect(win.every((w) => w.row.month <= "2026-06-01")).toBe(true);
    expect(win.map((w) => w.row.month)).toEqual(["2026-06-01", "2026-05-01", "2026-04-01"]);
  });
  it("gives newer months more weight", () => {
    const win = selectWindow(rows, "2026-10-01", 6, 3);
    expect(win[0].weight).toBe(1);
    expect(win[3].weight).toBeCloseTo(0.5, 10);
    expect(win[0].weight).toBeGreaterThan(win[5].weight);
  });
  it("is empty when nothing falls inside", () => {
    expect(selectWindow(rows, "2025-01-01", 6, 3)).toEqual([]);
  });
});

describe("weightedMean", () => {
  it("weights each value", () => {
    expect(weightedMean([{ value: 10, weight: 1 }, { value: 20, weight: 3 }])).toBe(17.5);
  });
  it("skips missing values and zero weights", () => {
    expect(weightedMean([{ value: null, weight: 5 }, { value: 8, weight: 2 }, { value: 100, weight: 0 }])).toBe(8);
  });
  it("is null when nothing counts", () => {
    expect(weightedMean([])).toBeNull();
    expect(weightedMean([{ value: null, weight: 1 }])).toBeNull();
  });
});

describe("scoreMetric", () => {
  const base = {
    key: "avg_days_late" as const,
    weight: 40,
    higherIsBetter: false,
    scale: { best: 0, worst: 15 },
    cohortMin: 8,
  };

  it("is missing when there is no value", () => {
    expect(scoreMetric({ ...base, value: null, cohort: [1, 2, 3] }).status).toBe("missing");
  });
  it("uses the fixed scale when the cohort is too small, and says so", () => {
    const m = scoreMetric({ ...base, value: 3, cohort: [1, 2, 3, 4, 5, 6, 7] });
    expect(m).toMatchObject({ status: "ok", method: "fixed", cohortSize: 7 });
    expect(m.score).toBeCloseTo(80, 5);
  });
  it("ranks by percentile once the cohort is big enough, and says so", () => {
    const cohort = [1, 2, 3, 4, 5, 6, 7, 8];
    const m = scoreMetric({ ...base, value: 0, cohort });
    expect(m).toMatchObject({ status: "ok", method: "percentile", cohortSize: 8, score: 100 });
  });
  it("is missing, not guessed, when the cohort is small and there is no scale", () => {
    expect(scoreMetric({ ...base, scale: undefined, value: 3, cohort: [] }).status).toBe("missing");
  });
});

describe("combineMetrics", () => {
  const ok = (weight: number, score: number): MetricResult => ({ ...ruleMetric("renewal_behaviour", weight, score) });

  it("takes the weighted mean of what was scored", () => {
    expect(combineMetrics([ok(30, 100), ok(10, 0)])).toEqual({ score: 75, confidence: 1 });
  });
  it("lowers confidence for missing metrics but not for not-applicable ones", () => {
    const withMissing = combineMetrics([ok(40, 100), missingMetric("on_time_share", 60)]);
    expect(withMissing.score).toBe(100);
    expect(withMissing.confidence).toBeCloseTo(0.4, 10);

    const withNa = combineMetrics([ok(40, 100), notApplicableMetric("on_time_share", 60)]);
    expect(withNa.confidence).toBe(1);
  });
  it("reports no score and zero confidence when nothing could be scored", () => {
    expect(combineMetrics([missingMetric("avg_days_late", 40)])).toEqual({ score: null, confidence: 0 });
    expect(combineMetrics([])).toEqual({ score: null, confidence: 0 });
    expect(combineMetrics([notApplicableMetric("avg_days_late", 40)])).toEqual({ score: null, confidence: 0 });
  });
});

describe("settings", () => {
  it("ships valid defaults", () => {
    expect(validateSettings(DEFAULT_SCORING_SETTINGS)).toEqual([]);
  });
  it("matches the agreed weights and cut-offs", () => {
    expect(DEFAULT_SCORING_SETTINGS.weights).toEqual({ profitability: 35, payment: 25, engagement: 20, friction: 20 });
    expect(DEFAULT_SCORING_SETTINGS.tierCutoffs).toEqual({ A: 75, B: 60, C: 40 });
  });
  it("merges an override over the defaults without losing the rest", () => {
    const s = mergeSettings({ weights: { payment: 40 } as ScoringSettings["weights"] });
    expect(s.weights).toEqual({ profitability: 35, payment: 40, engagement: 20, friction: 20 });
    expect(s.windowMonths).toBe(6);
  });
  it("refuses cut-offs that are out of order", () => {
    expect(() => mergeSettings({ tierCutoffs: { A: 50, B: 60, C: 40 } })).toThrow(/cut-offs/);
  });
  it("refuses all-zero pillar weights", () => {
    expect(() =>
      mergeSettings({ weights: { profitability: 0, payment: 0, engagement: 0, friction: 0 } })
    ).toThrow(/weight/);
  });
  it("refuses a scale with two equal ends", () => {
    expect(() => mergeSettings({ scales: { avg_days_late: { best: 5, worst: 5 } } })).toThrow(/scale/i);
  });
  it("refuses seat trend points that are not in increasing order", () => {
    expect(() => mergeSettings({ seatTrendPoints: [[0, 60], [0, 100]] })).toThrow(/Seat trend/);
  });
});
