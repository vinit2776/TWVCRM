import { describe, it, expect } from "vitest";
import { buildTodayComparison, dayClassOf, MIN_PEERS, type TodayStatus } from "../energy-today";
import type { LedgerBucket } from "../energy-baseline";

// Wh used in each 15-min slot of a working day: quiet night, a steep ramp at
// 09:00–10:00 IST, a plateau, then an evening tail.
const workingWh = (k: number) => (k < 36 ? 100 : k < 40 ? 1000 : k < 72 ? 2000 : k < 80 ? 1500 : 200);
const offWh = (k: number) => (k < 36 ? 100 : 150);
const WEEKEND = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

function addDay(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Contiguous ledger from `from` to `to` inclusive. `scale` stretches working-day
// usage; `todaySlots` (if given) truncates the last day to that many slots.
function ledger(opts: {
  from: string; to: string; scale?: number; todaySlots?: number; holidays?: string[];
}): LedgerBucket[] {
  const rows: LedgerBucket[] = [];
  let cum = 5_000_000;
  const scale = opts.scale ?? 1;
  for (let date = opts.from; date <= opts.to; date = addDay(date, 1)) {
    const isToday = date === opts.to;
    const off = WEEKEND(date) || (opts.holidays ?? []).includes(date);
    const n = isToday && opts.todaySlots != null ? opts.todaySlots : 96;
    const start = new Date(`${date}T00:00:00+05:30`).getTime();
    for (let k = 0; k < n; k++) {
      const wh = Math.round((off ? offWh(k) : workingWh(k)) * (isToday ? scale : 1));
      cum += wh;
      rows.push({ ts: new Date(start + k * 15 * 60 * 1000).toISOString(), energy_delta_wh: wh, cumulative_wh: cum });
    }
  }
  return rows;
}

// Thu 8 Oct 2026. `now` just after the last stored slot.
const THU = "2026-10-08";
const nowAt = (slots: number) => new Date(new Date(`${THU}T00:00:00+05:30`).getTime() + slots * 15 * 60 * 1000 + 60_000);
const HISTORY_FROM = "2026-09-05";
const YESTERDAY = "2026-10-07";

function run(todaySlots: number, scale = 1, history = { from: HISTORY_FROM }) {
  const rows = ledger({ from: history.from, to: THU, scale, todaySlots });
  return buildTodayComparison(rows, [], nowAt(todaySlots));
}
const statusAt = (slots: number, scale: number): TodayStatus => run(slots, scale).status;

describe("dayClassOf", () => {
  it("separates weekdays, Saturdays and off days", () => {
    expect(dayClassOf("2026-10-08", "working")).toBe("weekday");
    expect(dayClassOf("2026-10-10", "working")).toBe("saturday");
    expect(dayClassOf("2026-10-11", "sunday")).toBe("off");
    expect(dayClassOf("2026-10-02", "holiday")).toBe("off");
  });
});

describe("buildTodayComparison", () => {
  it("compares a normal day with the weekday baseline and calls it on track", () => {
    const c = run(60); // 15:00 IST, plateau reached
    expect(c.dayClass).toBe("weekday");
    expect(c.status).toBe("on_track");
    expect(c.peers).toBeGreaterThanOrEqual(MIN_PEERS);
    expect(c.todayKwh).toBeCloseTo(c.typicalNow!.med!, 1);
    expect(c.diffKwh).toBeCloseTo(0, 1);
    expect(c.projectedKwh).toBeCloseTo(c.typicalEnd!.med!, 1);
  });

  it("flags a day running well behind the typical pace", () => {
    expect(statusAt(60, 0.5)).toBe("behind");
  });

  it("flags a day running well ahead of the typical pace", () => {
    expect(statusAt(60, 1.6)).toBe("ahead");
  });

  it("refuses a verdict during the morning ramp", () => {
    // Slot 38 = 09:30 IST: typical day has done well under a quarter of its total.
    expect(statusAt(38, 1)).toBe("too_early");
    expect(statusAt(38, 3)).toBe("too_early");
  });

  it("projects the finish as usage so far plus the typical rest of the day", () => {
    const c = run(60, 1.2);
    const expected = c.todayKwh! + (c.typicalEnd!.med! - c.typicalNow!.med!);
    expect(c.projectedKwh).toBeCloseTo(expected, 1);
    // the projected line starts exactly where today's line ends
    const last = c.slots[c.lastSlot!];
    expect(last.proj).toBe(last.today);
    expect(c.slots[c.lastSlot! + 1].proj).not.toBeNull();
    expect(c.slots[c.lastSlot! - 1].proj).toBeNull();
  });

  it("reports per-slot power in kW", () => {
    const c = run(60);
    // Plateau slot: 2000 Wh in 15 min = 8 kW
    expect(c.slots[50].kw).toBe(8);
    expect(c.slots[50].kwMed).toBe(8);
    // Night slot: 100 Wh in 15 min = 0.4 kW
    expect(c.slots[10].kw).toBe(0.4);
  });

  it("says insufficient when there are too few comparable days", () => {
    const c = run(60, 1, { from: addDay(YESTERDAY, -1) });
    expect(c.status).toBe("insufficient");
    expect(c.slots[50].med).toBeNull();
    expect(c.slots[50].kw).toBe(8); // today's own curve is still shown
  });

  it("says no data when nothing has been stored today", () => {
    const rows = ledger({ from: HISTORY_FROM, to: YESTERDAY });
    const c = buildTodayComparison(rows, [], new Date(`${THU}T03:00:00Z`));
    expect(c.status).toBe("no_data");
    expect(c.lastSlot).toBeNull();
  });

  it("uses Sundays-and-holidays as the baseline for a holiday", () => {
    const hol = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-02", THU];
    const rows = ledger({ from: HISTORY_FROM, to: THU, todaySlots: 60, holidays: hol });
    const c = buildTodayComparison(rows, hol.map((d) => ({ date: d, name: "Holiday" })), nowAt(60));
    expect(c.dayClass).toBe("off");
    expect(c.peers).toBeGreaterThan(MIN_PEERS);
    expect(c.status).toBe("on_track");
    expect(c.typicalEnd!.med!).toBeLessThan(40); // not the ~170 kWh of a working day
  });

  it("falls back to all working days when too few Saturdays are complete", () => {
    const SAT = "2026-10-10";
    const rows = ledger({ from: "2026-10-01", to: SAT, todaySlots: 60 });
    const c = buildTodayComparison(rows, [], new Date(new Date(`${SAT}T00:00:00+05:30`).getTime() + 60 * 15 * 60 * 1000 + 60_000));
    expect(c.dayClass).toBe("saturday");
    expect(c.fallback).toBe(true);
  });

  it("excludes today and partial days from the baseline", () => {
    const c = run(60, 5); // today is wildly high but must not pull its own baseline up
    expect(c.typicalNow!.med!).toBeLessThan(c.todayKwh!);
    expect(c.status).toBe("ahead");
  });

  it("ignores off-grid provisional readings", () => {
    const rows = ledger({ from: HISTORY_FROM, to: THU, todaySlots: 60 });
    const last = rows[rows.length - 1];
    rows.push({ ts: new Date(new Date(last.ts).getTime() + 7 * 60 * 1000 + 3000).toISOString(), energy_delta_wh: 500, cumulative_wh: (last.cumulative_wh ?? 0) + 500 });
    const c = buildTodayComparison(rows, [], nowAt(61));
    expect(c.lastSlot).toBe(59);
  });
});
