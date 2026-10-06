import { describe, it, expect } from "vitest";
import {
  aggregateDaily, classifyDay, computeBaselines, findAnomalies, baselineStats, weekdayProfile, type LedgerBucket,
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
