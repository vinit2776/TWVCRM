import { describe, it, expect } from "vitest";
import { followUpGroup, groupFollowUps, soonestPerLead } from "../follow-up-groups";

// Thu 5 Nov 2026, 12:00 IST
const NOW = new Date("2026-11-05T06:30:00Z");
const at = (istDay: string) => `${istDay}T10:30:00Z`;

describe("followUpGroup", () => {
  it("puts a follow-up under the pill for its IST day", () => {
    expect(followUpGroup(at("2026-10-16"), NOW)).toBe("overdue");
    expect(followUpGroup(at("2026-11-04"), NOW)).toBe("overdue");
    expect(followUpGroup(at("2026-11-05"), NOW)).toBe("today");
    expect(followUpGroup(at("2026-11-06"), NOW)).toBe("tomorrow");
    expect(followUpGroup(at("2026-11-12"), NOW)).toBe("week");
    expect(followUpGroup(at("2026-11-13"), NOW)).toBe("later");
  });

  it("counts earlier today as today, not overdue, as the Leads list does", () => {
    expect(followUpGroup("2026-11-05T03:30:00Z", NOW)).toBe("today");
  });

  it("judges the day in IST, not UTC", () => {
    expect(followUpGroup("2026-11-05T19:00:00Z", NOW)).toBe("tomorrow");
    expect(followUpGroup("2026-11-05T18:00:00Z", NOW)).toBe("today");
  });
});

describe("soonestPerLead", () => {
  it("keeps the earliest follow-up for each lead", () => {
    const m = soonestPerLead([
      { lead_id: "a", follow_up_date: at("2026-11-09") },
      { lead_id: "a", follow_up_date: at("2026-10-16") },
      { lead_id: "b", follow_up_date: at("2026-11-06") },
    ]);
    expect(m.get("a")).toBe(at("2026-10-16"));
    expect(m.get("b")).toBe(at("2026-11-06"));
  });
});

describe("groupFollowUps", () => {
  const leads = [
    { id: "a", created_at: "2026-10-01T00:00:00Z" },
    { id: "b", created_at: "2026-10-02T00:00:00Z" },
    { id: "c", created_at: "2026-10-03T00:00:00Z" },
    { id: "d", created_at: "2026-10-04T00:00:00Z" },
    { id: "e", created_at: "2026-10-05T00:00:00Z" },
    { id: "f", created_at: "2026-10-06T00:00:00Z" },
  ];
  const nextDue = new Map([
    ["a", at("2026-10-20")], // overdue, 16 days
    ["b", at("2026-10-16")], // overdue, 20 days
    ["c", at("2026-11-05")], // today
  ]);

  it("counts every group and lists a lead under only one", () => {
    const g = groupFollowUps(nextDue, leads, NOW);
    expect(g.counts).toEqual({ overdue: 2, today: 1, tomorrow: 0, week: 0, later: 0, none: 3 });
  });

  it("runs Overdue longest overdue first", () => {
    expect(groupFollowUps(nextDue, leads, NOW).ids.overdue).toEqual(["b", "a"]);
  });

  it("lists leads with no next step newest first", () => {
    expect(groupFollowUps(nextDue, leads, NOW).ids.none).toEqual(["f", "e", "d"]);
  });
});
