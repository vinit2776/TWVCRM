import { describe, it, expect } from "vitest";
import { istDayKey, dayLabel, groupByDay, summariseDays } from "../lead-days";

describe("istDayKey", () => {
  it("uses the IST day, not the UTC one", () => {
    // 01:00 IST on 4 Nov is still 3 Nov in UTC
    expect(istDayKey("2026-11-03T19:30:00Z")).toBe("2026-11-04");
    expect(istDayKey("2026-11-04T10:00:00Z")).toBe("2026-11-04");
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-11-04T05:00:00Z"); // 10:30 IST, Wed 4 Nov
  it("names today and yesterday", () => {
    expect(dayLabel("2026-11-04", now)).toBe("Today · Wed 4 Nov");
    expect(dayLabel("2026-11-03", now)).toBe("Yesterday · Tue 3 Nov");
  });
  it("gives older days a plain date, with the year when it is not this year", () => {
    expect(dayLabel("2026-10-30", now)).toBe("Fri 30 Oct");
    expect(dayLabel("2025-12-31", now)).toContain("2025");
  });
});

describe("groupByDay", () => {
  it("groups consecutive leads of the same IST day", () => {
    const groups = groupByDay([
      { created_at: "2026-11-04T09:00:00Z" },
      { created_at: "2026-11-04T01:00:00Z" },
      { created_at: "2026-11-03T20:00:00Z" }, // 01:30 IST on 4 Nov, still the same day
      { created_at: "2026-11-03T08:00:00Z" },
    ]);
    expect(groups.map((g) => [g.key, g.leads.length])).toEqual([
      ["2026-11-04", 3],
      ["2026-11-03", 1],
    ]);
  });
});

describe("summariseDays", () => {
  it("counts leads per day and per source", () => {
    const s = summariseDays([
      { created_at: "2026-11-04T09:00:00Z", source: "google_ads" },
      { created_at: "2026-11-04T10:00:00Z", source: "google_ads" },
      { created_at: "2026-11-04T11:00:00Z", source: "meta_ads" },
      { created_at: "2026-11-03T09:00:00Z", source: "walkin" },
    ]);
    expect(s["2026-11-04"]).toEqual({ total: 3, sources: { google_ads: 2, meta_ads: 1 } });
    expect(s["2026-11-03"].total).toBe(1);
  });
});
