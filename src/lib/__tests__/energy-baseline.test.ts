import { describe, it, expect } from "vitest";
import {
  aggregateDaily, markGaps, classifyDay, computeBaselines, findAnomalies, baselineStats, weekdayProfile, type LedgerBucket,
} from "../energy-baseline";

// 96 buckets for an IST day, each `whPerBucket`. IST 00:00 = previous day 18:30Z.
function istDay(date: string, whPerBucket: number, buckets = 96): LedgerBucket[] {
  const start = new Date(`${date}T00:00:00+05:30`).getTime();
  return Array.from({ length: buckets }, (_, i) => ({
    ts: new Date(start + i * 15 * 60 * 1000).toISOString(),
    energy_delta_wh: whPerBucket,
  }));
}

describe("classifyDay", () => {
  const holidays = new Map([["2026-10-19", "Ayutha Pooja"], ["2026-11-08", "Deepavali"]]);
  it("marks Monday–Saturday as working", () => {
    expect(classifyDay("2026-10-17", holidays).dayType).toBe("working"); // Saturday
    expect(classifyDay("2026-10-14", holidays).dayType).toBe("working"); // Wednesday
  });
  it("marks Sunday", () => expect(classifyDay("2026-10-18", holidays).dayType).toBe("sunday"));
  it("holiday wins, including on a Sunday, and carries the name", () => {
    expect(classifyDay("2026-10-19", holidays)).toEqual({ dayType: "holiday", holidayName: "Ayutha Pooja" });
    expect(classifyDay("2026-11-08", holidays).dayType).toBe("holiday");
  });
});

describe("aggregateDaily", () => {
  it("groups by IST day, not UTC day", () => {
    const rows = aggregateDaily(istDay("2026-10-14", 1000), [], "2026-10-20");
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-10-14");
    expect(rows[0].kwh).toBe(96);
    expect(rows[0].complete).toBe(true);
  });
  it("never treats today or sparse days as complete", () => {
    const rows = aggregateDaily([...istDay("2026-10-14", 1000), ...istDay("2026-10-15", 1000, 40)], [], "2026-10-14");
    expect(rows.find((r) => r.date === "2026-10-14")!.complete).toBe(false); // today
    expect(rows.find((r) => r.date === "2026-10-15")!.complete).toBe(false); // 40 buckets
  });
  it("flags a day with a meter reset as incomplete", () => {
    const b = istDay("2026-10-14", 1000);
    b[10].energy_delta_wh = -5000;
    expect(aggregateDaily(b, [], "2026-10-20")[0].complete).toBe(false);
  });
});

describe("production-shaped ledger quirks", () => {
  it("does not count the delta that spans a ledger gap, and marks that day partial", () => {
    // 24 Sep ends, nothing until 3 Oct, then the first row carries ~9 days of usage.
    const day3 = istDay("2026-10-03", 1000, 60);
    day3[0].energy_delta_wh = 1_269_500;
    const rows = aggregateDaily([...istDay("2026-09-24", 1000, 40), ...day3], [], "2026-10-20");
    const d = rows.find((r) => r.date === "2026-10-03")!;
    expect(d.kwh).toBe(59); // 59 normal buckets × 1 kWh, the 1,269 kWh row dropped
    expect(d.complete).toBe(false);
  });
  it("keeps a full day complete when off-grid captures add extra rows", () => {
    const b = istDay("2026-10-14", 1000);
    const extras = [3, 40, 70].map((i) => ({
      ts: new Date(new Date(b[i].ts).getTime() + 7 * 60 * 1000 + 7000).toISOString(),
      energy_delta_wh: 100,
    }));
    const rows = aggregateDaily([...b, ...extras], [], "2026-10-20");
    expect(rows[0].buckets).toBe(96); // 99 rows, 96 distinct slots
    expect(rows[0].complete).toBe(true);
  });
  it("marks a day partial when an hour-plus hole sits inside it", () => {
    const b = istDay("2026-10-14", 1000).filter((_, i) => i < 40 || i > 48); // ~2h hole, 87 slots left
    expect(aggregateDaily(b, [], "2026-10-20")[0].complete).toBe(false);
  });
  it("markGaps flags only rows following a >60 min hole", () => {
    const b = istDay("2026-10-14", 1000).filter((_, i) => i < 5 || i > 8); // rows 4 → 9 = 75 min
    const flagged = markGaps(b).filter((r) => r.gap);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].ts).toBe(b[5].ts);
  });
});

describe("baselines", () => {
  const today = "2026-10-20";
  // Oct 6–19: working days 1000 Wh/bucket (96 kWh), Sundays 300 Wh/bucket (28.8 kWh)
  const buckets: LedgerBucket[] = [];
  for (let d = 6; d <= 19; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    buckets.push(...istDay(date, new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? 300 : 1000));
  }
  const holidays = [{ date: "2026-10-19", name: "Ayutha Pooja" }];
  const daily = aggregateDaily(buckets, holidays, today);
  const [d30] = computeBaselines(daily, buckets, today);

  it("separates working from non-working medians", () => {
    expect(d30.working.median).toBe(96);
    expect(d30.working.days).toBe(11); // 14 days − 2 Sundays − 1 holiday
    expect(d30.nonWorking.days).toBe(3);
  });
  it("reports base load from overnight non-working buckets", () => {
    // Sunday buckets are 300 Wh → 1.2 kW; the 19th (holiday) is 1000 Wh → 4 kW. Median of the mix.
    expect(d30.baseLoadKw).not.toBeNull();
  });
  it("reports where data actually starts", () => expect(d30.coveredFrom).toBe("2026-10-06"));
  it("profiles weekdays", () => {
    const sunday = weekdayProfile(daily, d30.from, d30.to).find((p) => p.weekday === 0)!;
    expect(sunday.median).toBe(28.8);
  });
  it("flags a spike on a working day", () => {
    const spiked = [...daily];
    const i = spiked.findIndex((d) => d.date === "2026-10-14");
    spiked[i] = { ...spiked[i], kwh: 160 };
    const flagged = findAnomalies(spiked, d30);
    expect(flagged.map((a) => a.date)).toContain("2026-10-14");
    expect(flagged.find((a) => a.date === "2026-10-14")!.deviationPct).toBeGreaterThan(50);
  });
  it("does not flag normal days", () => expect(findAnomalies(daily, d30)).toEqual([]));
});

describe("baselineStats", () => {
  it("handles empty and single inputs", () => {
    expect(baselineStats([]).median).toBeNull();
    expect(baselineStats([5]).median).toBe(5);
  });
});
