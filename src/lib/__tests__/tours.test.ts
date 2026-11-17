import { describe, it, expect } from "vitest";
import { tourBucket, tourChip, tourStats, tourSortAscending } from "../tours";

// Thu 5 Nov 2026, 12:00 IST
const NOW = new Date("2026-11-05T06:30:00Z");
const CUTOFF = new Date("2026-10-30T00:00:00Z");
// A one-hour tour starting at 4:00 pm IST on the given day.
const tour = (istDay: string, over: Partial<{ outcome: "came" | "no_show" | "cancelled" | null; cutoff: Date | null }> = {}) => ({
  start: `${istDay}T10:30:00Z`,
  end: `${istDay}T11:30:00Z`,
  outcome: null as "came" | "no_show" | "cancelled" | null,
  cutoff: CUTOFF as Date | null,
  ...over,
});

describe("tourBucket", () => {
  it("groups a tour that is still ahead by day", () => {
    expect(tourBucket(tour("2026-11-05"), NOW)).toBe("today");
    expect(tourBucket(tour("2026-11-06"), NOW)).toBe("tomorrow");
    expect(tourBucket(tour("2026-11-12"), NOW)).toBe("week");
    expect(tourBucket(tour("2026-11-13"), NOW)).toBe("later");
  });

  it("asks for an outcome once a tour's time has passed", () => {
    expect(tourBucket(tour("2026-11-03"), NOW)).toBe("needs_update");
    // Earlier today, already over.
    expect(tourBucket({ ...tour("2026-11-05"), start: "2026-11-05T03:30:00Z", end: "2026-11-05T04:30:00Z" }, NOW)).toBe("needs_update");
  });

  it("keeps a tour in progress under Today, not Needs update", () => {
    expect(tourBucket({ ...tour("2026-11-05"), start: "2026-11-05T06:00:00Z", end: "2026-11-05T07:00:00Z" }, NOW)).toBe("today");
  });

  it("treats a tour with no end as an hour long", () => {
    expect(tourBucket({ ...tour("2026-11-05"), start: "2026-11-05T05:00:00Z", end: null }, NOW)).toBe("needs_update");
  });

  it("lists a recorded tour as done, whenever it was", () => {
    expect(tourBucket(tour("2026-11-03", { outcome: "came" }), NOW)).toBe("done");
    expect(tourBucket(tour("2026-09-01", { outcome: "no_show" }), NOW)).toBe("done");
  });

  it("never asks about a tour from before the cut-off, or when there is no cut-off", () => {
    expect(tourBucket(tour("2026-10-20"), NOW)).toBe("legacy");
    expect(tourBucket(tour("2026-11-03", { cutoff: null }), NOW)).toBe("legacy");
  });

  it("judges the day in IST, not UTC", () => {
    // 12:30 am IST on 6 Nov is tomorrow, though it is still 5 Nov in UTC.
    expect(tourBucket({ ...tour("2026-11-05"), start: "2026-11-05T19:00:00Z", end: "2026-11-05T20:00:00Z" }, NOW)).toBe("tomorrow");
  });
});

describe("tourChip", () => {
  it("counts days ago for a tour awaiting an outcome", () => {
    expect(tourChip(tour("2026-11-03"), NOW)).toEqual({ state: "past", big: "2 days ago", when: "Tue 3 Nov, 4:00 pm" });
    expect(tourChip(tour("2026-11-04"), NOW).big).toBe("yesterday");
    expect(tourChip({ ...tour("2026-11-05"), start: "2026-11-05T03:30:00Z", end: "2026-11-05T04:30:00Z" }, NOW).big).toBe("earlier today");
  });

  it("uses the usual day count for a tour ahead", () => {
    expect(tourChip(tour("2026-11-05"), NOW)).toMatchObject({ state: "today", big: "Today", when: "4:00 pm" });
    expect(tourChip(tour("2026-11-08"), NOW)).toMatchObject({ state: "soon", big: "in 3 days", when: "Sun 8 Nov, 4:00 pm" });
  });
});

describe("tourStats", () => {
  it("counts recorded tours and how many that came went on to a proposal or deal", () => {
    const stats = tourStats([
      { outcome: "came", leadStatus: "proposal_sent" },
      { outcome: "came", leadStatus: "won" },
      { outcome: "came", leadStatus: "lost" },
      { outcome: "no_show", leadStatus: "tour_scheduled" },
      { outcome: "cancelled", leadStatus: "lost" },
    ]);
    expect(stats).toEqual({ total: 5, came: 3, noShow: 1, cancelled: 1, convertedOfCame: 2 });
  });

  it("leaves a tour with no outcome out of every number", () => {
    expect(tourStats([{ outcome: null, leadStatus: "tour_completed" }])).toEqual({ total: 0, came: 0, noShow: 0, cancelled: 0, convertedOfCame: 0 });
  });
});

describe("tourSortAscending", () => {
  it("runs oldest first until a tour is done, then newest first", () => {
    expect(tourSortAscending("needs_update")).toBe(true);
    expect(tourSortAscending("tomorrow")).toBe(true);
    expect(tourSortAscending("done")).toBe(false);
  });
});
