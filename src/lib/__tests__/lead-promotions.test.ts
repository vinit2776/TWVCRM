import { describe, it, expect } from "vitest";
import { daysBetween, runningOn, promotionsByDay, promotionResults, type Promotion, type InflowDay } from "../lead-promotions";

const promo = (o: Partial<Promotion> = {}): Promotion => ({ id: "p", name: "Diwali offer", source: null, starts_on: "2026-11-03", ends_on: "2026-11-05", spend: null, ...o });
const day = (total: number, sources: Record<string, number> = {}): InflowDay => ({ day: "", total, sources });

describe("promotions", () => {
  it("lists days inclusively", () => {
    expect(daysBetween("2026-11-01", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("runs from start to end inclusive, and open-ended promotions run until today", () => {
    expect(runningOn(promo(), "2026-11-03", "2026-11-20")).toBe(true);
    expect(runningOn(promo(), "2026-11-05", "2026-11-20")).toBe(true);
    expect(runningOn(promo(), "2026-11-06", "2026-11-20")).toBe(false);
    expect(runningOn(promo({ ends_on: null }), "2026-11-19", "2026-11-20")).toBe(true);
    expect(runningOn(promo({ ends_on: null }), "2026-11-21", "2026-11-20")).toBe(false);
  });

  it("maps each day to what was running", () => {
    const m = promotionsByDay([promo()], ["2026-11-02", "2026-11-04"], "2026-11-20");
    expect(Object.keys(m)).toEqual(["2026-11-04"]);
  });

  it("compares what it brought with the same number of days before, using its own source", () => {
    const inflow: Record<string, InflowDay> = {
      "2026-10-31": day(2, { meta_ads: 1, google_ads: 1 }),
      "2026-11-01": day(3, { meta_ads: 3 }),
      "2026-11-02": day(1, { meta_ads: 1 }),
      "2026-11-03": day(5, { meta_ads: 4, google_ads: 1 }),
      "2026-11-04": day(6, { meta_ads: 6 }),
      "2026-11-05": day(4, { meta_ads: 2, google_ads: 2 }),
    };
    const [any] = promotionResults([promo()], inflow, "2026-11-20");
    expect(any).toMatchObject({ enquiries: 15, before: 6, days: 3 });
    const [meta] = promotionResults([promo({ source: "meta_ads", spend: 9000 })], inflow, "2026-11-20");
    expect(meta).toMatchObject({ enquiries: 12, before: 5, costPerEnquiry: 750 });
  });

  it("has no cost per enquiry without spend or enquiries", () => {
    expect(promotionResults([promo({ spend: 5000 })], {}, "2026-11-20")[0].costPerEnquiry).toBeNull();
  });
});
