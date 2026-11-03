import { describe, it, expect } from "vitest";
import { leadStaleState, latestInstant } from "../lead-stale";

const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();
const base = { status: "contacted", hasFutureFollowUp: false, now: NOW };

describe("leadStaleState", () => {
  it("is stale at 15 quiet days, and not at 14", () => {
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(15) })).toEqual({ state: "stale", daysQuiet: 15 });
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(14) })).toEqual({ state: "warning", daysLeft: 1 });
  });

  it("counts down over the last three days, and is quiet before that", () => {
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(12) })).toEqual({ state: "warning", daysLeft: 3 });
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(11) })).toEqual({ state: "active" });
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(0) })).toEqual({ state: "active" });
  });

  it("is kept alive by a follow-up booked ahead, however quiet the lead has been", () => {
    expect(leadStaleState({ ...base, lastEventAt: daysAgo(60), hasFutureFollowUp: true })).toEqual({ state: "active" });
  });

  it("never applies to a pinned, archived or finished lead", () => {
    const old = daysAgo(60);
    expect(leadStaleState({ ...base, lastEventAt: old, pinnedAt: daysAgo(1) })).toEqual({ state: "active" });
    expect(leadStaleState({ ...base, lastEventAt: old, archivedAt: daysAgo(1) })).toEqual({ state: "active" });
    for (const status of ["won", "lost", "junk"]) {
      expect(leadStaleState({ ...base, status, lastEventAt: old })).toEqual({ state: "active" });
    }
  });

  it("applies to a lead in progress too (a tour booked weeks ago that nobody followed up)", () => {
    expect(leadStaleState({ ...base, status: "tour_scheduled", lastEventAt: daysAgo(20) }).state).toBe("stale");
  });
});

describe("latestInstant", () => {
  it("picks the newest and ignores missing values", () => {
    expect(latestInstant([null, "2026-11-01T00:00:00Z", undefined, "2026-11-05T00:00:00Z"])).toBe("2026-11-05T00:00:00Z");
    expect(latestInstant([null, undefined])).toBeNull();
  });
});
