import { describe, it, expect } from "vitest";
import {
  billableCasesForPeriod,
  legacyLineAmount,
  parseAggBillingMode,
  previewLegacyVsNew,
  termFee,
  termStartOf,
} from "@/lib/aggregator-term-billing";

const c = (o: Record<string, unknown>) => ({ id: "c1", rate: 12000, tenure_months: 12, start_date: "2026-03-10", activated_at: "2026-03-10T05:00:00Z", ...o }) as Parameters<typeof termFee>[0] & { id: string; start_date?: string; activated_at?: string };

describe("parseAggBillingMode", () => {
  it("defaults to legacy", () => {
    for (const v of [null, undefined, "", "bogus", 5, "ONCE_PER_TENURE"]) expect(parseAggBillingMode(v)).toBe("legacy");
  });
  it("accepts once_per_tenure", () => {
    expect(parseAggBillingMode("once_per_tenure")).toBe("once_per_tenure");
    expect(parseAggBillingMode(" once_per_tenure ")).toBe("once_per_tenure");
    expect(parseAggBillingMode("legacy")).toBe("legacy");
  });
});

describe("termFee", () => {
  it("uses rate as the term fee up to 12 months", () => {
    expect(termFee({ rate: 12000, tenure_months: 11 })).toBe(12000);
    expect(termFee({ rate: 12000, tenure_months: 12 })).toBe(12000);
    expect(termFee({ rate: 12000, tenure_months: null })).toBe(12000);
  });
  it("multiplies the annual rate for longer terms", () => {
    expect(termFee({ rate: 12000, tenure_months: 24 })).toBe(24000);
    expect(termFee({ rate: 12000, tenure_months: 36 })).toBe(36000);
    expect(termFee({ rate: 12000, tenure_months: 48 })).toBe(48000);
  });
  it("handles missing rate", () => {
    expect(termFee({ rate: null, tenure_months: 24 })).toBe(0);
  });
});

describe("termStartOf", () => {
  it("prefers start_date", () => expect(termStartOf({ start_date: "2026-03-10", activated_at: "2025-01-01T00:00:00Z" })).toBe("2026-03-10"));
  it("falls back to activated_at", () => expect(termStartOf({ start_date: null, activated_at: "2026-02-05T10:00:00Z" })).toBe("2026-02-05"));
  it("returns null when neither", () => expect(termStartOf({})).toBeNull());
});

describe("billableCasesForPeriod", () => {
  const args = { periodMonth: 3, periodYear: 2026, alreadyBilled: [] };
  it("returns empty for no cases", () => expect(billableCasesForPeriod({ ...args, cases: [] })).toEqual([]));
  it("bills a case activated mid-period at the full rate, no pro-rating", () => {
    const r = billableCasesForPeriod({ ...args, cases: [c({ start_date: "2026-03-28" })] });
    expect(r).toHaveLength(1);
    expect(r[0].amount).toBe(12000);
  });
  it("does not bill a multi-term case in later months", () => {
    expect(billableCasesForPeriod({ ...args, periodMonth: 4, cases: [c({})] })).toEqual([]);
  });
  it("bills an annual-rate multi-year term in full at its start", () => {
    const r = billableCasesForPeriod({ ...args, cases: [c({ tenure_months: 36 })] });
    expect(r[0].amount).toBe(36000);
  });
  it("bills a renewed term (new case, new start) in its own period only", () => {
    const renewed = c({ id: "c2", start_date: "2027-03-11" });
    expect(billableCasesForPeriod({ ...args, periodYear: 2027, cases: [renewed] })).toHaveLength(1);
    expect(billableCasesForPeriod({ ...args, periodYear: 2026, cases: [renewed] })).toHaveLength(0);
  });
  it("skips a term already billed, but not a different term of the same case id", () => {
    const billed = [{ case_id: "c1", term_start: "2026-03-10" }];
    expect(billableCasesForPeriod({ ...args, cases: [c({})], alreadyBilled: billed })).toEqual([]);
    expect(billableCasesForPeriod({ ...args, cases: [c({ start_date: "2026-03-20" })], alreadyBilled: billed })).toHaveLength(1);
  });
  it("skips zero or missing rate", () => {
    expect(billableCasesForPeriod({ ...args, cases: [c({ rate: 0 }), c({ id: "x", rate: null })] })).toEqual([]);
  });
});

describe("legacyLineAmount (unchanged legacy math)", () => {
  it("bills the full rate in a month after activation", () => {
    expect(legacyLineAmount({ rate: 12000, activated_at: "2026-01-10T12:00:00Z" }, 3, 2026)).toEqual({ amount: 12000, proRatedDays: undefined, totalDays: 31 });
  });
  it("pro-rates the activation month", () => {
    const r = legacyLineAmount({ rate: 3100, activated_at: "2026-03-16T12:00:00" }, 3, 2026);
    expect(r).toEqual({ amount: 1600, proRatedDays: 16, totalDays: 31 });
  });
  it("snapshot of sample line-item math", () => {
    const sample = [
      { rate: 12000, activated_at: "2026-03-16T12:00:00" },
      { rate: 5000, activated_at: "2025-06-01T12:00:00" },
      { rate: 2900, activated_at: null },
    ].map((x) => legacyLineAmount(x, 2, 2026));
    expect(sample).toEqual([
      { amount: 12000, proRatedDays: undefined, totalDays: 28 },
      { amount: 5000, proRatedDays: undefined, totalDays: 28 },
      { amount: 2900, proRatedDays: undefined, totalDays: 28 },
    ]);
  });
});

describe("previewLegacyVsNew", () => {
  it("returns empty for no cases", () => {
    expect(previewLegacyVsNew({ cases: [], periodMonth: 3, periodYear: 2026, alreadyBilled: [] })).toEqual([]);
  });
  it("shows legacy billing every month versus once", () => {
    const rows = previewLegacyVsNew({ cases: [c({}), c({ id: "c9", start_date: "2025-01-01", activated_at: "2025-01-01T00:00:00" })], periodMonth: 6, periodYear: 2026, alreadyBilled: [] });
    expect(rows.map((r) => [r.caseId, r.legacy, r.oncePerTenure, r.difference])).toEqual([
      ["c1", 12000, 0, -12000],
      ["c9", 12000, 0, -12000],
    ]);
  });
  it("shows the start period as billed in full", () => {
    const [row] = previewLegacyVsNew({ cases: [c({ tenure_months: 24 })], periodMonth: 3, periodYear: 2026, alreadyBilled: [] });
    expect(row.oncePerTenure).toBe(24000);
  });
});
