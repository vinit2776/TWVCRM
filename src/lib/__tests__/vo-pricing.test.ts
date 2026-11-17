import { describe, it, expect } from "vitest";
import { computeVoPricing, classifyRate, rateCardPurposeFor, buildDirectSnapshot, computeAggregatorCasePricing } from "@/lib/vo-pricing";

const row = (purpose: string, location_id: string | null, guide = 10000, floor: number | null = 8000, version = 3) => ({
  id: `${purpose}-${location_id}`, purpose, location_id, guide_fee: guide, floor_fee: floor, default_term_months: 12, version,
});
const rows = [row("gst_new", null), row("gst_new", "L1", 12000, 9000), row("gst_existing", null, 6000, null)];

describe("classifyRate", () => {
  it("below floor / between / at or above guide", () => {
    const c = { guide_fee: 10000, floor_fee: 8000 };
    expect(classifyRate(c, 7999.99)).toBe("below_floor");
    expect(classifyRate(c, 8000)).toBe("between");
    expect(classifyRate(c, 9999)).toBe("between");
    expect(classifyRate(c, 10000)).toBe("at_or_above_guide");
    expect(classifyRate(c, 15000)).toBe("at_or_above_guide");
  });
  it("no floor means never below floor", () => {
    expect(classifyRate({ guide_fee: 6000, floor_fee: null }, 1)).toBe("between");
  });
});

describe("computeVoPricing", () => {
  it("blocks when no rate exists", () => {
    const r = computeVoPricing({ purpose: "gst_new", locationId: "L9", termMonths: 12, rows: [row("gst_existing", null)] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/No rate card/);
  });
  it("uses exact location before Any", () => {
    const r = computeVoPricing({ purpose: "gst_new", locationId: "L1", termMonths: 12, rows });
    expect(r.ok && r.card.how).toBe("exact");
    expect(r.ok && r.guide).toBe(12000);
  });
  it("falls back to Any", () => {
    const r = computeVoPricing({ purpose: "gst_new", locationId: "L2", termMonths: 12, rows });
    expect(r.ok && r.card.how).toBe("any");
    expect(r.ok && r.card.version).toBe(3);
  });
  it("11 and 12 month terms are 1x; multi-year guide is years x yearly guide (D6)", () => {
    const g = (t: number) => { const r = computeVoPricing({ purpose: "gst_new", locationId: null, termMonths: t, rows }); return r.ok ? [r.termGuide, r.termFloor] : null; };
    expect(g(11)).toEqual([10000, 8000]);
    expect(g(12)).toEqual([10000, 8000]);
    expect(g(24)).toEqual([20000, 16000]);
    expect(g(36)).toEqual([30000, 24000]);
    expect(g(48)).toEqual([40000, 32000]);
  });
  it("quote assessment: rate is annual above 12 months and approval only below floor", () => {
    const q = (rate: number, term = 36) => {
      const r = computeVoPricing({ purpose: "gst_new", locationId: null, termMonths: term, rows, quotedRate: rate });
      return r.ok ? r.quote : null;
    };
    expect(q(7000)).toMatchObject({ classification: "below_floor", requiresApproval: true, termFee: 21000 });
    expect(q(9000)).toMatchObject({ classification: "between", requiresApproval: false });
    expect(q(20000)).toMatchObject({ classification: "at_or_above_guide", requiresApproval: false });
    expect(q(7000, 12)).toMatchObject({ termFee: 7000, requiresApproval: true });
  });
  it("suggested ask leans up on a high win rate, else the guide", () => {
    const base = { purpose: "gst_new", locationId: null, termMonths: 12, rows };
    const hot = computeVoPricing({ ...base, trend: { won: 5, avgWon: 11000, winRate: 70 } });
    const cold = computeVoPricing({ ...base, trend: { won: 1, avgWon: 11000, winRate: 20 } });
    expect(hot.ok && hot.suggestedAsk).toBe(11600);
    expect(cold.ok && cold.suggestedAsk).toBe(10000);
  });
  it("snapshot freezes card version and amounts", () => {
    const r = computeVoPricing({ purpose: "gst_new", locationId: null, termMonths: 24, rows, quotedRate: 7000 });
    if (!r.ok) throw new Error("expected ok");
    const s = buildDirectSnapshot(r, new Date("2026-11-12T00:00:00Z"));
    expect(s).toMatchObject({ card_version: 3, guide_rate: 10000, floor_rate: 8000, quoted_rate: 7000, quoted_term_fee: 14000, requires_approval: true });
  });
});

describe("rateCardPurposeFor", () => {
  it("maps legacy gst_registration and ignores purposes with no card", () => {
    expect(rateCardPurposeFor("gst_registration")).toBe("gst_new");
    expect(rateCardPurposeFor("gst_existing")).toBe("gst_existing");
    expect(rateCardPurposeFor("mail_handling")).toBeNull();
  });
});

describe("computeAggregatorCasePricing", () => {
  const agg = [
    { id: "a1", purpose: "gst_new", location_id: null, pricing_type: "open" as const, share_percent: 40, min_customer_price: 5000, fixed_rate: null, version: 2 },
    { id: "a2", purpose: "gst_existing", location_id: "L1", pricing_type: "fixed" as const, share_percent: null, min_customer_price: null, fixed_rate: 3000, version: 1 },
  ];
  it("blocks when the aggregator has no matching row", () => {
    const r = computeAggregatorCasePricing({ purpose: "gst_existing", locationId: "L2", termMonths: 12, customerRate: 9000, rows: agg });
    expect(r.ok).toBe(false);
  });
  it("open share snapshot", () => {
    const r = computeAggregatorCasePricing({ purpose: "gst_new", locationId: "L1", termMonths: 12, customerRate: 10000, rows: agg });
    expect(r.ok && r.snapshot).toMatchObject({ pricing_type: "open", share_percent: 40, our_amount: 4000, card_match: "any", below_minimum: false });
  });
  it("fixed price snapshot and below-minimum flag", () => {
    const f = computeAggregatorCasePricing({ purpose: "gst_existing", locationId: "L1", termMonths: 12, customerRate: 9000, rows: agg });
    expect(f.ok && f.snapshot).toMatchObject({ pricing_type: "fixed", our_amount: 3000, card_match: "exact" });
    const low = computeAggregatorCasePricing({ purpose: "gst_new", locationId: null, termMonths: 12, customerRate: 4000, rows: agg });
    expect(low.ok && low.snapshot.below_minimum).toBe(true);
  });
});
