import { describe, it, expect } from "vitest";
import {
  billMonthOf, checkLinkInput, continuityVerdict, fitVerdict, gridUnits, kwhBetween, lineAmount, sumLines,
  type LinkInput, type LinkLine,
} from "../electricity-link";
import type { MidnightReadings } from "../energy-monthly";

const energy = (units: number, rate: number): LinkLine => ({ charge_category: "energy", units, rate, meter_label: "Main HT meter" });
const amt = (charge_category: LinkLine["charge_category"], amount: number): LinkLine => ({ charge_category, amount });

// ₹223,830 bill from the plan: energy 111,072 + DG 29,400 + fixed 38,640 − PF 2,250 + taxes 46,968
const goodLines: LinkLine[] = [
  energy(12_480, 8.9),
  { charge_category: "generator", units: 1_050, rate: 28 },
  amt("fixed_demand", 38_640),
  amt("pf_adjustment", -2_250),
  amt("taxes", 46_968),
];
const input = (over: Partial<LinkInput> = {}): LinkInput => ({
  period_start: "2026-09-01", period_end: "2026-09-30",
  opening_reading: null, closing_reading: null, max_demand_kva: null, billed_pf: null, lines: goodLines, ...over,
});

describe("line amounts", () => {
  it("energy and generator are units × rate, rounded to paise", () => {
    expect(lineAmount(energy(12_480, 8.9))).toBe(111_072);
    expect(lineAmount({ charge_category: "generator", units: 3, rate: 0.333 })).toBe(1);
  });
  it("other charges carry their own amount, which may be negative", () => {
    expect(lineAmount(amt("pf_adjustment", -2_250))).toBe(-2_250);
    expect(lineAmount(amt("taxes", 46_968))).toBe(46_968);
  });
  it("is null when it cannot be worked out", () => {
    expect(lineAmount({ charge_category: "energy", units: 0, rate: 8 })).toBeNull();
    expect(lineAmount({ charge_category: "energy", units: 10, rate: null })).toBeNull();
    expect(lineAmount({ charge_category: "taxes", amount: 0 })).toBeNull();
    expect(lineAmount({ charge_category: "taxes" })).toBeNull();
  });
  it("sums the lines", () => {
    expect(sumLines(goodLines)).toBe(223_830);
  });
  it("grid units count the energy lines only, never the generator", () => {
    expect(gridUnits(goodLines)).toBe(12_480);
    expect(gridUnits([energy(100, 8), energy(50, 8), { charge_category: "generator", units: 999, rate: 28 }])).toBe(150);
  });
});

describe("billMonthOf — the month holding most of the period", () => {
  it("a calendar month is that month", () => {
    expect(billMonthOf("2026-09-01", "2026-09-30")).toEqual({ month: 9, year: 2026 });
  });
  it("a 5 Sep – 4 Oct bill counts as September", () => {
    expect(billMonthOf("2026-09-05", "2026-10-04")).toEqual({ month: 9, year: 2026 });
  });
  it("a 20 Sep – 19 Oct bill counts as October", () => {
    expect(billMonthOf("2026-09-20", "2026-10-19")).toEqual({ month: 10, year: 2026 });
  });
  it("an exact tie goes to the month the period ends in", () => {
    // 1 Feb – 28 Feb 2027 is one month; use a 2-day span across a boundary: 31 Jan + 1 Feb
    expect(billMonthOf("2027-01-31", "2027-02-01")).toEqual({ month: 2, year: 2027 });
  });
  it("crosses a year boundary", () => {
    expect(billMonthOf("2026-12-10", "2027-01-09")).toEqual({ month: 12, year: 2026 });
    expect(billMonthOf("2026-12-25", "2027-01-24")).toEqual({ month: 1, year: 2027 });
  });
});

describe("checkLinkInput — lines must agree with the vendor bill", () => {
  it("accepts lines that add up to the total", () => {
    expect(checkLinkInput(input(), 223_830).errors).toEqual([]);
  });
  it("tolerates rounding of up to ₹1 either way", () => {
    expect(checkLinkInput(input(), 223_830.9).errors).toEqual([]);
    expect(checkLinkInput(input(), 223_829.1).errors).toEqual([]);
  });
  it("rejects a total that is out, saying by how much and in which direction", () => {
    const over = checkLinkInput(input(), 223_000).errors.join(" ");
    expect(over).toMatch(/₹830 over/);
    const short = checkLinkInput(input(), 225_000).errors.join(" ");
    expect(short).toMatch(/₹1,170 short/);
  });
  it("does not total the lines when one of them is incomplete", () => {
    const r = checkLinkInput(input({ lines: [energy(100, 8), { charge_category: "taxes" }] }), 5_000);
    expect(r.errors.some((e) => /Line 2/.test(e))).toBe(true);
    expect(r.errors.some((e) => /add up/.test(e))).toBe(false);
  });
  it("needs at least one line", () => {
    expect(checkLinkInput(input({ lines: [] }), 100).errors).toContain("Add at least one charge line.");
  });
  it("warns when there is no energy line to compare with the meter", () => {
    const r = checkLinkInput(input({ lines: [amt("taxes", 1_000)] }), 1_000);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/No energy/);
  });
});

describe("checkLinkInput — period and readings", () => {
  it("rejects missing, reversed and over-long periods", () => {
    expect(checkLinkInput(input({ period_start: "" }), 223_830).errors.join(" ")).toMatch(/billing period/);
    expect(checkLinkInput(input({ period_start: "2026-09-30", period_end: "2026-09-01" }), 223_830).errors.join(" ")).toMatch(/ends before it starts/);
    expect(checkLinkInput(input({ period_start: "2026-01-01", period_end: "2026-06-30" }), 223_830).errors.join(" ")).toMatch(/longer than 93 days/);
  });
  it("accepts a two-month period", () => {
    expect(checkLinkInput(input({ period_start: "2026-08-01", period_end: "2026-09-30" }), 223_830).errors).toEqual([]);
  });
  it("needs both readings or neither", () => {
    expect(checkLinkInput(input({ opening_reading: 1000 }), 223_830).errors.join(" ")).toMatch(/both/);
    expect(checkLinkInput(input({ closing_reading: 1000 }), 223_830).errors.join(" ")).toMatch(/both/);
  });
  it("rejects a closing reading below the opening one", () => {
    expect(checkLinkInput(input({ opening_reading: 2000, closing_reading: 1000 }), 223_830).errors.join(" ")).toMatch(/lower than/);
  });
  it("only warns when the readings disagree with the energy units — a multiplying factor is common", () => {
    const r = checkLinkInput(input({ opening_reading: 1_402_118, closing_reading: 1_414_598 }), 223_830);   // 12,480 apart
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const off = checkLinkInput(input({ opening_reading: 1_000, closing_reading: 1_120 }), 223_830);          // 120 apart vs 12,480
    expect(off.errors).toEqual([]);
    expect(off.warnings.join(" ")).toMatch(/multiplying factor/);
  });
  it("validates demand and power factor ranges", () => {
    expect(checkLinkInput(input({ max_demand_kva: 0 }), 223_830).errors.join(" ")).toMatch(/demand/);
    expect(checkLinkInput(input({ billed_pf: 1.2 }), 223_830).errors.join(" ")).toMatch(/Power factor/);
    expect(checkLinkInput(input({ billed_pf: 0 }), 223_830).errors.join(" ")).toMatch(/Power factor/);
    expect(checkLinkInput(input({ max_demand_kva: 118, billed_pf: 0.97 }), 223_830).errors).toEqual([]);
  });
});

describe("fitVerdict", () => {
  it("fits within 2%, close within 10%, off beyond", () => {
    expect(fitVerdict(12_480, 12_310)).toEqual({ pct: 1.4, status: "fits" });
    expect(fitVerdict(12_480, 11_850)).toEqual({ pct: 5.3, status: "close" });
    expect(fitVerdict(12_480, 4_880).status).toBe("off");
  });
  it("is unknown when there is nothing to compare", () => {
    expect(fitVerdict(12_480, null).status).toBe("unknown");
    expect(fitVerdict(12_480, 0).status).toBe("unknown");
    expect(fitVerdict(0, 12_000).status).toBe("unknown");
  });
  it("shows a bill below the meter as a negative difference", () => {
    expect(fitVerdict(11_000, 12_000)).toMatchObject({ status: "close" });
    expect(fitVerdict(11_000, 12_000).pct).toBeLessThan(0);
  });
});

describe("kwhBetween — from the meter's midnight readings", () => {
  const readings: MidnightReadings = new Map([
    ["2026-09-01", 1_000_000],
    ["2026-10-01", 1_000_000 + 12_310_000],
  ]);
  it("is the register at the end of the last day minus the start of the first", () => {
    expect(kwhBetween(readings, "2026-09-01", "2026-09-30")).toBe(12_310);
  });
  it("is null when either reading is missing", () => {
    expect(kwhBetween(readings, "2026-08-31", "2026-09-30")).toBeNull();
    expect(kwhBetween(readings, "2026-09-01", "2026-10-05")).toBeNull();
  });
  it("is null when the register went backwards", () => {
    const reset: MidnightReadings = new Map([["2026-09-01", 5_000_000], ["2026-10-01", 100]]);
    expect(kwhBetween(reset, "2026-09-01", "2026-09-30")).toBeNull();
  });
});

describe("continuityVerdict", () => {
  it("continues when the opening equals the previous closing, within a rounding unit", () => {
    expect(continuityVerdict(1_402_118, 1_402_118)).toEqual({ diff: 0, status: "continues" });
    expect(continuityVerdict(1_402_119, 1_402_118).status).toBe("continues");
  });
  it("a higher opening means readings were missed", () => {
    expect(continuityVerdict(1_410_000, 1_402_118)).toMatchObject({ status: "gap" });
  });
  it("a lower opening means the periods overlap or this is not the next bill", () => {
    expect(continuityVerdict(771_540, 1_402_118)).toMatchObject({ status: "overlap" });
  });
  it("is unknown without both figures", () => {
    expect(continuityVerdict(null, 100).status).toBe("unknown");
    expect(continuityVerdict(100, null).status).toBe("unknown");
  });
});
