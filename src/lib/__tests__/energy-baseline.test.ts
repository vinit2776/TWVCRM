import { describe, it, expect } from "vitest";
import {
  aggregateDaily, markGaps, classifyDay, computeBaselines, findAnomalies, baselineStats, weekdayProfile, type LedgerBucket,
} from "../energy-baseline";

// Rows for an IST day with a running cumulative reading, as the ledger stores them.
// `cum` carries the meter total across days so day totals difference correctly.
let cum = 1_000_000;
function istDay(date: string, whPerBucket: number, buckets = 96): LedgerBucket[] {
  const start = new Date(`${date}T00:00:00+05:30`).getTime();
  return Array.from({ length: buckets }, (_, i) => {
    cum += whPerBucket;
    return {
      ts: new Date(start + i * 15 * 60 * 1000).toISOString(),
      energy_delta_wh: whPerBucket,
      cumulative_wh: cum,
    };
  });
}
// A day preceding the data under test, so the first real day has a prior reading.
const priming = () => istDay("2026-10-13", 1000);

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
    const rows = aggregateDaily([...priming(), ...istDay("2026-10-14", 1000)], [], "2026-10-20");
    const d = rows.find((r) => r.date === "2026-10-14")!;
    expect(d.kwh).toBe(96);
    expect(d.complete).toBe(true);
  });
  it("never treats today, sparse days or the ledger's first day as complete", () => {
    const rows = aggregateDaily([...priming(), ...istDay("2026-10-14", 1000), ...istDay("2026-10-15", 1000, 40)], [], "2026-10-14");
    expect(rows.find((r) => r.date === "2026-10-13")!.complete).toBe(false); // no earlier reading
    expect(rows.find((r) => r.date === "2026-10-14")!.complete).toBe(false); // today
    expect(rows.find((r) => r.date === "2026-10-15")!.complete).toBe(false); // 40 slots
  });
  it("flags a day whose meter total went backwards", () => {
    const b = istDay("2026-10-14", 1000);
    b.forEach((r, i) => { if (i > 50) r.cumulative_wh = (r.cumulative_wh ?? 0) - 500_000; }); // reset mid-day
    const d = aggregateDaily([...priming(), ...b], [], "2026-10-20").find((r) => r.date === "2026-10-14")!;
    expect(d.complete).toBe(false);
  });
});

describe("production-shaped ledger quirks", () => {
  it("a gap-spanning day is partial and its total is the observed span only", () => {
    // 24 Sep ends, nothing until 3 Oct, then the first row carries ~9 days of usage.
    const early = istDay("2026-09-24", 1000, 40);
    cum += 1_269_500; // the unobserved stretch
    const day3 = istDay("2026-10-03", 1000, 60);
    day3[0].energy_delta_wh = 1_269_500; // what the old writer stored
    const d = aggregateDaily([...early, ...day3], [], "2026-10-20").find((r) => r.date === "2026-10-03")!;
    expect(d.complete).toBe(false);
    expect(d.kwh).toBe(59); // 59 observed 1 kWh steps; the 1,269 kWh jump is not attributed to the day
  });
  it("is immune to a corrupted stored delta (negative first row of a re-synced range)", () => {
    const prior = priming();
    const b = istDay("2026-10-14", 1000);
    b[0].energy_delta_wh = -1900; // as written by a sync whose seed sat after the first row
    const d = aggregateDaily([...prior, ...b], [], "2026-10-20").find((r) => r.date === "2026-10-14")!;
    expect(d.kwh).toBe(96);
    expect(d.complete).toBe(true);
  });
  it("does not double count off-grid captures that carry their own delta", () => {
    const prior = priming();
    const b = istDay("2026-10-14", 1000);
    // Resync recomputed the on-grid rows against each other, so the off-grid row's
    // delta (100 Wh) is now extra. The total must stay the true 96 kWh.
    const extras = [3, 40, 70].map((i) => ({
      ts: new Date(new Date(b[i].ts).getTime() + 7 * 60 * 1000 + 7000).toISOString(),
      energy_delta_wh: 100,
      cumulative_wh: (b[i].cumulative_wh ?? 0) + 100,
    }));
    const d = aggregateDaily([...prior, ...b, ...extras], [], "2026-10-20").find((r) => r.date === "2026-10-14")!;
    expect(d.buckets).toBe(96);
    expect(d.kwh).toBeCloseTo(96, 0);
    expect(d.complete).toBe(true);
  });
  it("marks a day partial when an hour-plus hole sits inside it", () => {
    const b = istDay("2026-10-14", 1000).filter((_, i) => i < 40 || i > 48);
    expect(aggregateDaily([...priming(), ...b], [], "2026-10-20").find((r) => r.date === "2026-10-14")!.complete).toBe(false);
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
  const buckets: LedgerBucket[] = [...istDay("2026-10-05", 1000)];
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
  it("reports where data actually starts", () => expect(d30.coveredFrom).toBe("2026-10-05"));
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
