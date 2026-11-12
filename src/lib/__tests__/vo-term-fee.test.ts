import { describe, expect, it } from "vitest";
import { annualRateFor, termFee } from "@/lib/vo-term-fee";
import { termFee as offerTermFee, annualRateFor as offerAnnual } from "@/lib/vo-renewal-offer";
import { termFee as aggTermFee } from "@/lib/aggregator-term-billing";

describe("termFee", () => {
  it.each([[6], [11], [12]])("is the rate itself for a %i month term", (m) => {
    expect(termFee(18000, m)).toBe(18000);
  });
  it.each([
    [24, 36000],
    [36, 54000],
    [48, 72000],
  ])("is rate x years for a %i month term", (m, fee) => {
    expect(termFee(18000, m)).toBe(fee);
  });
  it("rounds to 2 decimals", () => {
    expect(termFee(10000.005, 24)).toBe(20000.01);
    expect(termFee(1000.333, 36)).toBe(3001);
  });
  it("treats missing tenure or rate safely", () => {
    expect(termFee(18000, null)).toBe(18000);
    expect(termFee(null, 24)).toBe(0);
  });
  it("is shared by the offer and aggregator helpers", () => {
    expect(offerTermFee(18000, 24)).toBe(36000);
    expect(aggTermFee({ rate: 18000, tenure_months: 24 })).toBe(36000);
  });
});

describe("annualRateFor", () => {
  it.each([[6], [11], [12]])("stores the fee for %i months", (m) => {
    expect(annualRateFor(18000, m)).toBe(18000);
  });
  it.each([
    [24, 36000, 18000],
    [36, 54000, 18000],
    [48, 72000, 18000],
  ])("stores fee x 12 / months for %i months", (m, fee, rate) => {
    expect(annualRateFor(fee, m)).toBe(rate);
  });
  it("rounds to 2 decimals", () => {
    expect(annualRateFor(10000, 36)).toBe(3333.33);
  });
  it("round-trips with termFee", () => {
    for (const m of [6, 11, 12, 24, 36, 48]) {
      expect(termFee(annualRateFor(24000, m), m)).toBe(24000);
    }
    expect(offerAnnual(36000, 24)).toBe(18000);
  });
});
