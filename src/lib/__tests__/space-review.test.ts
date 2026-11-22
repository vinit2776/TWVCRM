import { describe, it, expect } from "vitest";
import { demandByArea, lookAgainDue, parseReviewDays, parseSpaceReviewMode, reviewDue } from "../space-review";

const NOW = new Date("2026-11-22T06:00:00Z");

describe("reviewDue", () => {
  it("counts from parking when never reviewed", () => {
    expect(reviewDue({ parkedAt: "2026-09-23T06:00:00Z" }, 60, NOW)).toBe(true); // 60 days
    expect(reviewDue({ parkedAt: "2026-09-24T06:00:00Z" }, 60, NOW)).toBe(false); // 59 days
  });
  it("counts from the last review once there is one", () => {
    expect(reviewDue({ parkedAt: "2026-01-01T06:00:00Z", lastReviewedAt: "2026-11-01T06:00:00Z" }, 60, NOW)).toBe(false);
  });
});

describe("lookAgainDue", () => {
  it("is due on the day and after, never before or when unset", () => {
    expect(lookAgainDue("2026-11-22", NOW)).toBe(true);
    expect(lookAgainDue("2026-11-01", NOW)).toBe(true);
    expect(lookAgainDue("2026-11-23", NOW)).toBe(false);
    expect(lookAgainDue(null, NOW)).toBe(false);
  });
});

describe("settings", () => {
  it("reads a bad interval or mode as the default", () => {
    expect(parseReviewDays("90")).toBe(90);
    expect(parseReviewDays("2")).toBe(60);
    expect(parseReviewDays("soon")).toBe(60);
    expect(parseReviewDays(undefined)).toBe(60);
    expect(parseSpaceReviewMode("live")).toBe("live");
    expect(parseSpaceReviewMode("x")).toBe("dry_run");
  });
});

describe("demandByArea", () => {
  const row = (over: Partial<Parameters<typeof demandByArea>[0][number]>) => ({ locationName: null, otherArea: "Anna Nagar", reason: "not_open", seatsNeeded: 4, parkedAt: "2026-11-12T06:00:00Z", ...over });
  it("groups by centre or area, biggest first, with seats and the longest wait", () => {
    const d = demandByArea([row({}), row({ seatsNeeded: 6, parkedAt: "2026-10-23T06:00:00Z" }), row({ otherArea: null, locationName: "Perungudi", reason: "no_space_of_size", seatsNeeded: null })], NOW);
    expect(d[0]).toEqual({ group: "Anna Nagar (not open)", waiting: 2, seats: 10, seatsKnown: 2, oldestDays: 30 });
    expect(d[1]).toMatchObject({ group: "Perungudi: no space of this size", waiting: 1, seats: 0, seatsKnown: 0 });
  });
  it("is empty with nothing waiting", () => expect(demandByArea([], NOW)).toEqual([]));
});
