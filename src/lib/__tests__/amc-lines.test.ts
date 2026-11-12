import { describe, it, expect } from "vitest";
import { canCombineLines, combinedPerCycleCost, countedVisitsByAsset, combinedVisitsUsed } from "@/lib/procurement/amc-lines";

const line = (over = {}) => ({ id: "l", unit: "quarter", quantity: 4, estimated_price: 12000, linked_asset_id: "a", already_ordered_qty: 0, ...over });

describe("canCombineLines", () => {
  it("combines lines with the same frequency and cycles", () => {
    expect(canCombineLines([line({ id: "1", linked_asset_id: "a" }), line({ id: "2", linked_asset_id: "b" })])).toEqual({ ok: true });
  });
  it("needs at least two lines", () => {
    expect(canCombineLines([line()])).toMatchObject({ ok: false });
  });
  it("rejects different frequencies", () => {
    const r = canCombineLines([line(), line({ unit: "half_year" })]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/frequenc/);
  });
  it("rejects different cycle counts", () => {
    const r = canCombineLines([line(), line({ quantity: 2 })]);
    expect((r as { reason: string }).reason).toMatch(/cycles/);
  });
  it("rejects an already ordered line", () => {
    expect(canCombineLines([line(), line({ already_ordered_qty: 4 })])).toMatchObject({ ok: false });
  });
  it("rejects a line with no asset", () => {
    expect(canCombineLines([line(), line({ linked_asset_id: null })])).toMatchObject({ ok: false });
  });
});

describe("combinedPerCycleCost", () => {
  it("adds per-cycle costs", () => {
    expect(combinedPerCycleCost([line({ estimated_price: 12000 }), line({ estimated_price: "8000.5" })])).toBe(20000.5);
  });
});

describe("visits per asset", () => {
  const events = [
    { asset_id: "a", event_type: "preventive" },
    { asset_id: "a", event_type: "annual_service" },
    { asset_id: "a", event_type: "breakdown" },
    { asset_id: "b", event_type: "preventive" },
    { asset_id: "b", event_type: "remote_support" },
    { asset_id: null, event_type: "preventive" },
    { asset_id: "z", event_type: "preventive" },
  ];
  it("counts only preventive and annual visits for the PO's assets", () => {
    expect(countedVisitsByAsset(events, ["a", "b", "c"])).toEqual({ a: 2, b: 1, c: 0 });
  });
  it("uses the minimum across assets as visits used", () => {
    expect(combinedVisitsUsed({ a: 2, b: 1, c: 0 })).toBe(0);
    expect(combinedVisitsUsed({ a: 4, b: 3 })).toBe(3);
    expect(combinedVisitsUsed({})).toBe(0);
  });
});
