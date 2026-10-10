import { describe, it, expect } from "vitest";
import {
  buildMonth, compareSameDays, cumulativeAt, daysInMonth, monthLabel, monthStats, projectMonth, shiftMonth, trend,
  type LatestReading, type MidnightReadings,
} from "../energy-monthly";

/** Register that rises `kwhPerDay(date)` each day, read at every IST midnight in [from, to]. */
function register(from: string, to: string, kwhPerDay: (date: string) => number, start = 1_000_000): MidnightReadings {
  const out: MidnightReadings = new Map();
  let cum = start;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    out.set(date, cum);
    cum += kwhPerDay(date) * 1000;
  }
  return out;
}
const flat = (n: number) => () => n;

describe("calendar helpers", () => {
  it("knows month lengths, including leap years", () => {
    expect(daysInMonth("2026-09")).toBe(30);
    expect(daysInMonth("2026-10")).toBe(31);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-02")).toBe(28);
  });
  it("shifts months across a year boundary", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-10", -12)).toBe("2025-10");
    expect(shiftMonth("2026-11", 3)).toBe("2027-02");
  });
  it("labels months", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2026-10", true)).toBe("Oct 26");
    expect(monthLabel("2026-09", true)).toBe("Sep 26"); // not "Sept"
  });
});

describe("buildMonth — from the meter's running total", () => {
  const TODAY = "2026-10-09";
  // 200 kWh/day, readings through the start of the 9th (today) plus a latest reading late on the 9th.
  const readings = register("2026-08-25", "2026-10-09", flat(200));
  const latest: LatestReading = { date: TODAY, cumulative_wh: readings.get(TODAY)! + 120_000 };

  it("a finished month has a day-by-day and cumulative series", () => {
    const m = buildMonth("2026-09", readings, latest, TODAY);
    expect(m.elapsedDays).toBe(30);
    expect(m.partial).toBe(false);
    expect(m.daily.every((v) => v === 200)).toBe(true);
    expect(cumulativeAt(m, 1)).toBe(200);
    expect(cumulativeAt(m, 30)).toBe(6000);
    expect(m.totalKwh).toBe(6000);
    expect(m.unknownDays).toBe(0);
  });

  it("the current month stops at today and counts today's partial usage", () => {
    const m = buildMonth("2026-10", readings, latest, TODAY);
    expect(m.elapsedDays).toBe(9);
    expect(m.partial).toBe(true);
    expect(m.daily[7]).toBe(200);          // 8 Oct complete
    expect(m.daily[8]).toBe(120);          // 9 Oct so far
    expect(m.daily[9]).toBeNull();         // 10 Oct hasn't happened
    expect(m.totalKwh).toBe(8 * 200 + 120);
  });

  it("a future month has nothing", () => {
    const m = buildMonth("2026-11", readings, latest, TODAY);
    expect(m.elapsedDays).toBe(0);
    expect(m.totalKwh).toBeNull();
  });

  it("a missing reading in the middle hides those days but not the month-to-date total", () => {
    const r = new Map(readings);
    r.delete("2026-09-14");
    const m = buildMonth("2026-09", r, latest, TODAY);
    expect(m.daily[12]).toBeNull();        // 13 Sep: end reading missing
    expect(m.daily[13]).toBeNull();        // 14 Sep: start reading missing
    expect(m.unknownDays).toBe(2);
    // Month-to-date needs only the month start and that day's own end-of-day reading:
    expect(m.cumulative[12]).toBeNull();       // end of 13 Sep IS the missing 14 Sep midnight reading
    expect(m.cumulative[13]).toBe(14 * 200);   // end of 14 Sep is intact — the hole before it doesn't matter
    expect(m.totalKwh).toBe(30 * 200);         // and the month total is untouched
  });

  it("unknown is null, never zero", () => {
    const r = new Map(readings);
    r.delete("2026-09-14");
    const m = buildMonth("2026-09", r, latest, TODAY);
    expect(m.daily.filter((v) => v === 0)).toHaveLength(0);
  });

  it("a missing month-start reading means no figure rather than a wrong one", () => {
    const r = new Map(readings);
    r.delete("2026-09-01");
    const m = buildMonth("2026-09", r, latest, TODAY);
    expect(m.totalKwh).toBeNull();
    expect(m.cumulative.every((v) => v === null)).toBe(true);
  });

  it("a meter reset (reading goes backwards) is skipped", () => {
    const r = new Map(readings);
    r.set("2026-09-10", 500);              // register dropped
    const m = buildMonth("2026-09", r, latest, TODAY);
    expect(m.daily[8]).toBeNull();         // 9 Sep ends below its start
  });
});

describe("compareSameDays", () => {
  const TODAY = "2026-10-09";
  const readings = register("2025-09-25", "2026-10-09", (d) => (d.startsWith("2026-10") ? 220 : d.startsWith("2026-09") ? 200 : 180));
  const latest: LatestReading = { date: TODAY, cumulative_wh: readings.get(TODAY)! + 220_000 };

  it("compares month-to-date with the same number of days of last month", () => {
    const cur = buildMonth("2026-10", readings, latest, TODAY);
    const prev = buildMonth("2026-09", readings, latest, TODAY);
    const c = compareSameDays(cur, prev)!;
    expect(c.days).toBe(9);
    expect(c.curKwh).toBe(9 * 220);
    expect(c.otherKwh).toBe(9 * 200);
    expect(c.pct).toBe(10);
  });

  it("compares a finished month over the shorter of the two lengths", () => {
    const sep = buildMonth("2026-09", readings, latest, TODAY);
    const oct25 = buildMonth("2025-10", readings, latest, TODAY);
    const c = compareSameDays(sep, oct25)!;
    expect(c.days).toBe(30);
    expect(c.pct).toBe(Math.round((200 / 180 - 1) * 1000) / 10);
  });

  it("says nothing when the other month has no figure", () => {
    const cur = buildMonth("2026-10", readings, latest, TODAY);
    const none = buildMonth("2024-10", readings, latest, TODAY);
    expect(compareSameDays(cur, none)).toBeNull();
    expect(compareSameDays(cur, null)).toBeNull();
  });
});

describe("projectMonth", () => {
  it("adds the usual figure for each remaining kind of day, not a flat average", () => {
    // Weekdays 300, Saturdays 200, Sundays 100.
    const per = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 100 : w === 6 ? 200 : 300; };
    const TODAY = "2026-10-15";
    const readings = register("2026-09-20", "2026-10-15", per);
    const latest: LatestReading = { date: TODAY, cumulative_wh: readings.get(TODAY)! + per(TODAY) * 1000 };
    const cur = buildMonth("2026-10", readings, latest, TODAY);
    const prev = buildMonth("2026-09", readings, null, TODAY);
    // Actual full October under the same pattern:
    let actual = 0;
    for (let d = 1; d <= 31; d++) actual += per(`2026-10-${String(d).padStart(2, "0")}`);
    expect(projectMonth(cur, prev)).toBe(actual);
  });

  it("is null too early in the month, and for a finished month", () => {
    const TODAY = "2026-10-02";
    const readings = register("2026-09-01", "2026-10-02", flat(200));
    const latest: LatestReading = { date: TODAY, cumulative_wh: readings.get(TODAY)! + 50_000 };
    expect(projectMonth(buildMonth("2026-10", readings, latest, TODAY), null)).toBeNull();
    expect(projectMonth(buildMonth("2026-09", readings, latest, TODAY), null)).toBeNull();
  });
});

describe("trend and stats", () => {
  const TODAY = "2026-10-09";
  const readings = register("2025-09-01", "2026-10-09", flat(200));
  const latest: LatestReading = { date: TODAY, cumulative_wh: readings.get(TODAY)! + 100_000 };

  it("returns n months oldest-first, flagging the one in progress", () => {
    const t = trend("2026-10", 13, readings, latest, TODAY);
    expect(t).toHaveLength(13);
    expect(t[0].month).toBe("2025-10");
    expect(t[12].month).toBe("2026-10");
    expect(t[12].partial).toBe(true);
    expect(t[11].kwh).toBe(30 * 200);
    expect(t[1].kwh).toBe(30 * 200); // Nov 2025
  });

  it("reports average per day and the busiest day from known days only", () => {
    const r = register("2026-09-01", "2026-10-01", (d) => (d === "2026-09-12" ? 500 : 200));
    const m = buildMonth("2026-09", r, null, TODAY);
    const s = monthStats(m);
    expect(s.peakDay).toEqual({ day: 12, kwh: 500 });
    expect(s.avgPerDay).toBeCloseTo((29 * 200 + 500) / 30, 1);
  });
});
