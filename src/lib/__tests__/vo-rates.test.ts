import { describe, it, expect } from "vitest";
import { lookupDirectRate, classifyQuote, scaleForTerm, suggestedAsk, computeTrend } from "@/lib/vo-rates";

const row = (purpose: string, location_id: string | null, guide = 10000, floor: number | null = 8000) => ({
  purpose, location_id, guide_fee: guide, floor_fee: floor, default_term_months: 12,
});

describe("lookupDirectRate", () => {
  const rows = [row("gst_new", null), row("gst_new", "L1", 12000), row("gst_existing", null, 9000)];
  it("prefers the exact location", () => {
    const m = lookupDirectRate(rows, "gst_new", "L1");
    expect(m?.how).toBe("exact");
    expect(m?.row.guide_fee).toBe(12000);
  });
  it("falls back to Any location", () => {
    expect(lookupDirectRate(rows, "gst_new", "L2")?.how).toBe("any");
    expect(lookupDirectRate(rows, "gst_new", null)?.how).toBe("any");
  });
  it("returns null when the purpose has no row", () => {
    expect(lookupDirectRate([row("gst_new", "L1")], "gst_new", "L2")).toBeNull();
    expect(lookupDirectRate(rows, "other", "L1")).toBeNull();
  });
});

describe("classifyQuote", () => {
  const r = { guide_fee: 10000, floor_fee: 8000 };
  it("classifies each band", () => {
    expect(classifyQuote(r, 11000)).toBe("above_guide");
    expect(classifyQuote(r, 10000)).toBe("at_guide");
    expect(classifyQuote(r, 9000)).toBe("below_guide");
    expect(classifyQuote(r, 8000)).toBe("below_guide");
    expect(classifyQuote(r, 7999)).toBe("below_floor");
  });
  it("has no below_floor without a floor", () => {
    expect(classifyQuote({ guide_fee: 10000, floor_fee: null }, 1)).toBe("below_guide");
  });
});

describe("scaleForTerm", () => {
  it("treats 11 and 12 months as one year", () => {
    expect(scaleForTerm(10000, 11)).toBe(10000);
    expect(scaleForTerm(10000, 12)).toBe(10000);
  });
  it("multiplies by years for longer terms", () => {
    expect(scaleForTerm(10000, 24)).toBe(20000);
    expect(scaleForTerm(10000, 36)).toBe(30000);
    expect(scaleForTerm(10000, 48)).toBe(40000);
  });
});

describe("suggestedAsk", () => {
  it("returns the guide when the win rate is low or avg unknown", () => {
    expect(suggestedAsk({ guide: 10000, avgWon: 12000, winRate: 59 })).toBe(10000);
    expect(suggestedAsk({ guide: 10000, avgWon: null, winRate: 90 })).toBe(10000);
    expect(suggestedAsk({ guide: 10000, avgWon: 12000, winRate: null })).toBe(10000);
  });
  it("leans up to avgWon * 1.05 rounded to 100 at 60 percent or more", () => {
    expect(suggestedAsk({ guide: 10000, avgWon: 12000, winRate: 60 })).toBe(12600);
    expect(suggestedAsk({ guide: 10000, avgWon: 12345, winRate: 75 })).toBe(13000);
  });
  it("never goes below the guide", () => {
    expect(suggestedAsk({ guide: 10000, avgWon: 8000, winRate: 80 })).toBe(10000);
  });
});

describe("computeTrend", () => {
  const now = new Date("2026-06-30T00:00:00Z");
  const outcomes = [
    { price: 10000, outcome: "won" as const, at: "2026-06-20T00:00:00Z" },
    { price: 12000, outcome: "won" as const, at: "2026-06-01T00:00:00Z" },
    { price: 9000, outcome: "lost" as const, at: "2026-06-10T00:00:00Z" },
    { price: 9500, outcome: "expired" as const, at: "2026-06-11T00:00:00Z" },
    { price: 50000, outcome: "won" as const, at: "2025-01-01T00:00:00Z" },
  ];
  it("summarises only the window", () => {
    expect(computeTrend(outcomes, 90, now)).toEqual({ won: 2, avgWon: 11000, winRate: 50 });
  });
  it("is empty with no outcomes in range", () => {
    expect(computeTrend([], 90, now)).toEqual({ won: 0, avgWon: null, winRate: null });
    expect(computeTrend(outcomes, 1, now)).toEqual({ won: 0, avgWon: null, winRate: null });
  });
});
