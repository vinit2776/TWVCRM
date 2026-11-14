import { describe, it, expect } from "vitest";
import { printTotals, waivedNote, isPrintLikeCharge } from "../print-usage-markers";

describe("printTotals", () => {
  it("separates billable from waived (TWV-C-0044 September)", () => {
    expect(printTotals({ bwAmount: 440, colourAmount: 60, bwWaived: true, colourWaived: false })).toEqual({ gross: 500, waived: 440, billable: 60 });
  });
  it("bills everything when nothing is waived", () => {
    expect(printTotals({ bwAmount: 440, colourAmount: 60, bwWaived: false, colourWaived: false })).toEqual({ gross: 500, waived: 0, billable: 500 });
  });
  it("handles both waived", () => {
    expect(printTotals({ bwAmount: 10, colourAmount: 5.5, bwWaived: true, colourWaived: true }).billable).toBe(0);
  });
});

describe("waivedNote", () => {
  it("names who, when (IST) and why", () => {
    expect(waivedNote({ waived_at: "2026-10-14T05:57:30.677Z", waive_reason: "Over Quota is 88 pages", waived_by_user: { full_name: "Noorul" } }))
      .toBe('Waived by Noorul on 14 Oct: "Over Quota is 88 pages"');
  });
  it("copes with missing parts", () => {
    expect(waivedNote({ waived_at: "2026-10-14T05:57:30Z" })).toBe("Waived on 14 Oct");
    expect(waivedNote({})).toBe("Waived");
  });
});

describe("isPrintLikeCharge", () => {
  it("recognises the descriptions that caused the October mix-ups", () => {
    expect(isPrintLikeCharge("Print out charge -Sep month")).toBe(true);
    expect(isPrintLikeCharge("Color print services for September")).toBe(true);
    expect(isPrintLikeCharge("B&W print, September 2026: 88 over quota at ₹5")).toBe(true);
    expect(isPrintLikeCharge("Extra", "B/W Print out Charges")).toBe(true);
  });
  it("ignores unrelated charges", () => {
    expect(isPrintLikeCharge("Extra chairs for event")).toBe(false);
    expect(isPrintLikeCharge("Manpower - OT")).toBe(false);
    expect(isPrintLikeCharge(null)).toBe(false);
  });
});
