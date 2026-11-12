import { describe, it, expect } from "vitest";
import {
  bandKwh,
  buildDayCurves,
  dailyPeaks,
  dayCurve,
  peakRank,
  peakVsPrior,
  slotLabel,
  summariseDay,
  topPeakDays,
  type DayPeak,
} from "../energy-peak";
import type { LedgerBucket } from "../energy-baseline";

const SLOT = 15 * 60 * 1000;
// IST midnight of 2026-10-08 = 2026-10-07T18:30:00Z
const MIDNIGHT = Date.parse("2026-10-07T18:30:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Rows at consecutive 15-min stamps starting at `startMs`, stepping `whPerSlot[i]` each. */
function ledger(startMs: number, whPerSlot: number[], startCum = 1_000_000): LedgerBucket[] {
  const rows: LedgerBucket[] = [{ ts: iso(startMs), energy_delta_wh: null, cumulative_wh: startCum }];
  let cum = startCum;
  whPerSlot.forEach((wh, i) => {
    cum += wh;
    rows.push({ ts: iso(startMs + (i + 1) * SLOT), energy_delta_wh: wh, cumulative_wh: cum });
  });
  return rows;
}

const flat = (wh: number, n = 96) => Array<number>(n).fill(wh);

describe("buildDayCurves — demand comes from cumulative steps, ×4", () => {
  it("turns Wh per quarter-hour into kW", () => {
    const curves = buildDayCurves(ledger(MIDNIGHT, flat(2500))); // 2.5 kWh per 15 min = 10 kW
    const day = curves.get("2026-10-08")!;
    expect(day).toHaveLength(96);
    expect(day[0]).toBeCloseTo(10, 5);
    expect(day[95]).toBeCloseTo(10, 5);
  });

  it("attributes a slot to the quarter-hour it covers, so the reading stamped midnight closes slot 95", () => {
    const rows = ledger(MIDNIGHT, flat(1000));
    const curves = buildDayCurves(rows);
    // 96 slots on the 8th; the midnight reading belongs to the 8th, not the 9th.
    expect(curves.get("2026-10-08")!.filter((v) => v != null)).toHaveLength(96);
    expect(curves.has("2026-10-09")).toBe(false);
  });

  it("a gap-spanning stored delta cannot fake a peak", () => {
    // Real incident shape: ~9 days of usage dumped into one row after a hole.
    const a = ledger(MIDNIGHT, flat(2500, 8)); // 00:00–02:00
    const resumeMs = MIDNIGHT + 8 * SLOT + 9 * 24 * 3_600_000;
    const b: LedgerBucket[] = [
      { ts: iso(resumeMs), energy_delta_wh: 1_269_000, cumulative_wh: 2_300_000 }, // huge delta, no reading 15 min before
      { ts: iso(resumeMs + SLOT), energy_delta_wh: 2500, cumulative_wh: 2_302_500 },
    ];
    const curves = buildDayCurves([...a, ...b]);
    const all = [...curves.values()].flat().filter((v): v is number => v != null);
    expect(Math.max(...all)).toBeLessThan(11); // nothing near 1,269,000 Wh × 4
  });

  it("skips a negative step (meter reset)", () => {
    const rows = ledger(MIDNIGHT, [2500, 2500]);
    rows[2] = { ...rows[2], cumulative_wh: 500 }; // counter dropped
    const day = buildDayCurves(rows).get("2026-10-08")!;
    expect(day[0]).toBeCloseTo(10, 5);
    expect(day[1]).toBeNull();
  });

  it("ignores off-grid captures", () => {
    const rows = ledger(MIDNIGHT, [2500]);
    rows.push({ ts: iso(MIDNIGHT + SLOT + 4 * 60 * 1000), energy_delta_wh: 100, cumulative_wh: 1_002_600 });
    const day = buildDayCurves(rows).get("2026-10-08")!;
    expect(day.filter((v) => v != null)).toHaveLength(1);
  });

  it("splits at IST midnight, not UTC midnight", () => {
    // Slots straddling 2026-10-08T18:30Z are the 9th in India.
    const rows = ledger(MIDNIGHT + 96 * SLOT - 2 * SLOT, flat(1000, 4)); // 23:30 → 00:30
    const curves = buildDayCurves(rows);
    expect(curves.get("2026-10-08")!.filter((v) => v != null)).toHaveLength(2);
    expect(curves.get("2026-10-09")!.filter((v) => v != null)).toHaveLength(2);
  });
});

describe("summariseDay", () => {
  const holidays = new Map<string, string>();
  it("finds the peak slot, average, day total and load factor", () => {
    const wh = flat(2500);
    wh[56] = 10_000; // 14:00–14:15 → 40 kW
    const day = buildDayCurves(ledger(MIDNIGHT, wh)).get("2026-10-08")!;
    const s = summariseDay("2026-10-08", day, "2026-10-10", holidays)!;
    expect(s.peakKw).toBe(40);
    expect(s.peakSlot).toBe(56);
    expect(slotLabel(s.peakSlot)).toBe("14:00");
    expect(s.kwh).toBeCloseTo((95 * 2500 + 10_000) / 1000, 1);
    expect(s.loadFactor).toBeCloseTo(s.avgKw / 40, 1);
    expect(s.complete).toBe(true);
  });

  it("base load is the overnight median, unmoved by a single spike", () => {
    const wh = flat(2500);
    wh[10] = 20_000; // a spike at 02:30 inside the overnight window
    const day = buildDayCurves(ledger(MIDNIGHT, wh)).get("2026-10-08")!;
    expect(summariseDay("2026-10-08", day, "2026-10-10", holidays)!.baseKw).toBe(10);
  });

  it("a partial or current day is not complete", () => {
    const day = buildDayCurves(ledger(MIDNIGHT, flat(2500, 40))).get("2026-10-08")!;
    expect(summariseDay("2026-10-08", day, "2026-10-10", holidays)!.complete).toBe(false); // 40 slots
    const full = buildDayCurves(ledger(MIDNIGHT, flat(2500))).get("2026-10-08")!;
    expect(summariseDay("2026-10-08", full, "2026-10-08", holidays)!.complete).toBe(false); // today
  });

  it("returns null for a day with no usable slot", () => {
    expect(summariseDay("2026-10-08", new Array(96).fill(null), "2026-10-10", holidays)).toBeNull();
  });
});

describe("dailyPeaks / dayCurve", () => {
  it("returns summaries inside the range only, oldest first, tagged by day type", () => {
    const rows = [
      ...ledger(MIDNIGHT, flat(2500)),                  // 8 Oct (Thu)
      ...ledger(MIDNIGHT + 96 * SLOT, flat(1000), 5_000_000), // 9 Oct (Fri)
    ];
    const out = dailyPeaks(rows, [{ date: "2026-10-09", name: "Test holiday" }], "2026-10-12", "2026-10-08", "2026-10-09");
    expect(out.map((d) => d.date)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(out[1].dayType).toBe("holiday");
    expect(out[0].dayType).toBe("working");
  });

  it("dayCurve is 96 long, with nulls for a day that has no data", () => {
    expect(dayCurve([], "2026-10-08")).toEqual(new Array(96).fill(null));
  });
});

describe("bands, comparison and ranking", () => {
  it("band kWh sums to the day total", () => {
    const day = buildDayCurves(ledger(MIDNIGHT, flat(2500))).get("2026-10-08")!;
    const bands = bandKwh(day);
    expect(bands).toHaveLength(4);
    expect(bands.reduce((a, b) => a + b.kwh, 0)).toBeCloseTo(240, 1);
  });

  const mk = (date: string, peakKw: number, complete = true): DayPeak => ({
    date, dayType: "working", peakKw, peakSlot: 56, avgKw: 20, kwh: 480, baseKw: 10, loadFactor: 0.5, slots: complete ? 96 : 40, complete,
  });

  it("compares against the average peak of complete days in the prior week", () => {
    const daily = [mk("2026-10-01", 100), mk("2026-10-02", 100), mk("2026-10-03", 100), mk("2026-10-04", 100), mk("2026-10-08", 120)];
    expect(peakVsPrior(daily, "2026-10-08")).toEqual({ pct: 20, avgKw: 100, basis: "working" });
  });

  it("says nothing when there are too few prior days", () => {
    expect(peakVsPrior([mk("2026-10-07", 100), mk("2026-10-08", 120)], "2026-10-08")).toBeNull();
  });

  it("compares a Sunday only with other Sundays, never with working days", () => {
    const sun = (date: string, peakKw: number): DayPeak => ({ ...mk(date, peakKw), dayType: "sunday" });
    const weekdays = [mk("2026-09-30", 100), mk("2026-10-01", 100), mk("2026-10-02", 100), mk("2026-10-03", 100)];
    // Only weekdays before it: no like-for-like comparison to make.
    expect(peakVsPrior([...weekdays, sun("2026-10-04", 50)], "2026-10-04")).toBeNull();
    const sundays = [sun("2026-09-13", 50), sun("2026-09-20", 50), sun("2026-09-27", 50)];
    expect(peakVsPrior([...weekdays, ...sundays, sun("2026-10-04", 60)], "2026-10-04")).toEqual({ pct: 20, avgKw: 50, basis: "off" });
  });

  it("ignores partial days in the comparison", () => {
    const daily = [mk("2026-10-01", 100), mk("2026-10-02", 100), mk("2026-10-03", 500, false), mk("2026-10-08", 120)];
    expect(peakVsPrior(daily, "2026-10-08")).toBeNull(); // only 2 complete prior days
  });

  it("ranks by peak among complete days, and not at all without enough history", () => {
    const days = Array.from({ length: 12 }, (_, i) => mk(`2026-09-${String(i + 1).padStart(2, "0")}`, 100 + i));
    expect(peakRank(days, "2026-09-12")).toEqual({ rank: 1, of: 12 });
    expect(peakRank(days, "2026-09-01")).toEqual({ rank: 12, of: 12 });
    expect(peakRank(days.slice(0, 5), "2026-09-05")).toBeNull();
  });

  it("lists the highest complete peaks first", () => {
    const daily = [mk("2026-10-01", 90), mk("2026-10-02", 140), mk("2026-10-03", 999, false), mk("2026-10-04", 120)];
    expect(topPeakDays(daily, 2).map((d) => d.date)).toEqual(["2026-10-02", "2026-10-04"]);
  });
});
