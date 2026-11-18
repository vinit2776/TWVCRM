import { describe, it, expect } from "vitest";
import { voFloorSummary } from "@/lib/approval-display";

describe("voFloorSummary", () => {
  it("shows quoted vs floor with the gap", () => {
    expect(voFloorSummary({ quoted_rate: 8000, floor_rate: 9000, term_months: 12 })).toBe("Quoted ₹8,000 vs floor ₹9,000 (₹1,000 below), 12 months");
  });
  it("flags per-year rates above 12 months", () => {
    expect(voFloorSummary({ quoted_rate: 7000, floor_rate: 9000, term_months: 24 })).toContain("24 months (per-year rate)");
  });
  it("copes with missing numbers", () => {
    expect(voFloorSummary(null)).toBe("Below-floor Virtual Office quote");
    expect(voFloorSummary({ quoted_rate: 5000 })).toBe("Quoted ₹5,000");
  });
});
