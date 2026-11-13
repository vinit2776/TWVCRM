import { describe, it, expect } from "vitest";
import { lookupAggregatorRate, computeAggregatorInvoice, copyCardRows, validateRowInput, type AggregatorRateRow } from "@/lib/vo-aggregator-rates";

const open = (o: Partial<AggregatorRateRow> = {}): AggregatorRateRow => ({
  purpose: "gst_new", location_id: null, pricing_type: "open", share_percent: 40, min_customer_price: 5000, fixed_rate: null, ...o,
});
const fixed = (o: Partial<AggregatorRateRow> = {}): AggregatorRateRow => ({
  purpose: "gst_new", location_id: null, pricing_type: "fixed", share_percent: null, min_customer_price: null, fixed_rate: 3000, ...o,
});

describe("lookupAggregatorRate", () => {
  const rows = [open(), open({ location_id: "L1", share_percent: 50 })];
  it("exact then any then null", () => {
    expect(lookupAggregatorRate(rows, "gst_new", "L1")?.how).toBe("exact");
    expect(lookupAggregatorRate(rows, "gst_new", "L9")?.how).toBe("any");
    expect(lookupAggregatorRate(rows, "gst_existing", "L1")).toBeNull();
  });
});

describe("computeAggregatorInvoice", () => {
  it("open: share of the ex-GST price, CGST/SGST when same state", () => {
    const r = computeAggregatorInvoice({ row: open(), customerPrice: 10000, priceIncludesGst: false, sameStateAsTwv: true });
    expect(r).toMatchObject({ customerPriceExGst: 10000, ours: 4000, retained: 6000, gst: 720, cgst: 360, sgst: 360, igst: 0, total: 4720, belowMinimum: false });
  });
  it("open: strips GST from an inclusive price, IGST when interstate", () => {
    const r = computeAggregatorInvoice({ row: open(), customerPrice: 11800, priceIncludesGst: true, sameStateAsTwv: false });
    expect(r).toMatchObject({ customerPriceExGst: 10000, ours: 4000, igst: 720, cgst: 0, sgst: 0, total: 4720 });
  });
  it("flags a price below the minimum", () => {
    expect(computeAggregatorInvoice({ row: open(), customerPrice: 4999, priceIncludesGst: false, sameStateAsTwv: true }).belowMinimum).toBe(true);
    expect(computeAggregatorInvoice({ row: open({ min_customer_price: null }), customerPrice: 1, priceIncludesGst: false, sameStateAsTwv: true }).belowMinimum).toBe(false);
  });
  it("fixed: always the fixed rate", () => {
    const r = computeAggregatorInvoice({ row: fixed(), customerPrice: 9000, priceIncludesGst: false, sameStateAsTwv: true });
    expect(r).toMatchObject({ ours: 3000, retained: 6000, gst: 540, total: 3540, belowMinimum: false });
  });
});

describe("copyCardRows", () => {
  it("resets to version 1 on the new date and drops identifiers", () => {
    const out = copyCardRows([{ ...open({ version: 4 }), id: "x", aggregator_id: "a" }], { effectiveFrom: "2026-12-01" });
    expect(out).toEqual([{ purpose: "gst_new", location_id: null, pricing_type: "open", share_percent: 40, min_customer_price: 5000, fixed_rate: null, version: 1, effective_from: "2026-12-01" }]);
  });
});

describe("validateRowInput", () => {
  it("accepts valid rows", () => {
    expect(validateRowInput(open())).toEqual([]);
    expect(validateRowInput(fixed())).toEqual([]);
  });
  it("rejects bad open rows", () => {
    expect(validateRowInput(open({ share_percent: null }))).toHaveLength(1);
    expect(validateRowInput(open({ share_percent: 0 }))).toHaveLength(1);
    expect(validateRowInput(open({ share_percent: 100 }))).toHaveLength(1);
    expect(validateRowInput(open({ fixed_rate: 5 }))).toHaveLength(1);
  });
  it("rejects bad fixed rows", () => {
    expect(validateRowInput(fixed({ fixed_rate: null }))).toHaveLength(1);
    expect(validateRowInput(fixed({ share_percent: 10 }))).toHaveLength(1);
    expect(validateRowInput(fixed({ min_customer_price: 100 }))).toHaveLength(1);
  });
  it("rejects an unknown purpose", () => {
    expect(validateRowInput(open({ purpose: "x" }))).toContain("Unknown purpose");
  });
});
