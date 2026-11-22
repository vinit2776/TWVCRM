import { describe, it, expect } from "vitest";
import { buildTourEventBody, staleCalendarUsers, tourCalendarPeople } from "../tour-calendar";

const ws = (e: string | null | undefined) => !!e && e.endsWith("@theworkvilla.com");

describe("tourCalendarPeople", () => {
  it("gives the host and the accompanier an entry each", () => {
    const p = tourCalendarPeople({ id: "h", email: "h@theworkvilla.com" }, { id: "a", email: "a@theworkvilla.com" }, ws);
    expect(p.map((x) => [x.userId, x.role])).toEqual([["h", "host"], ["a", "accompanying"]]);
  });
  it("gives someone who is both one entry, as host", () => {
    const p = tourCalendarPeople({ id: "h", email: "h@theworkvilla.com" }, { id: "h", email: "h@theworkvilla.com" }, ws);
    expect(p).toHaveLength(1);
    expect(p[0].role).toBe("host");
  });
  it("skips anyone without a workspace address, and handles nobody", () => {
    expect(tourCalendarPeople({ id: "h", email: "h@gmail.com" }, { id: "a", email: null }, ws)).toEqual([]);
    expect(tourCalendarPeople(null, null, ws)).toEqual([]);
  });
});

describe("staleCalendarUsers", () => {
  it("finds the entries whose person no longer has the tour", () => {
    const wanted = tourCalendarPeople({ id: "h2", email: "h2@theworkvilla.com" }, null, ws);
    expect(staleCalendarUsers(["h", "h2"], wanted)).toEqual(["h"]);
  });
});

describe("buildTourEventBody", () => {
  const base = { customer: "Meera Joshi", centre: "Perungudi", startIso: "2026-11-21T05:30:00Z", endIso: "2026-11-21T06:30:00Z", role: "host" as const, hostName: "Arun K", requirement: "Hot desk · 4 seats", leadUrl: "https://x/leads/1" };
  it("titles it with the customer and centre and invites nobody", () => {
    const b = buildTourEventBody(base);
    expect(b.summary).toBe("Tour: Meera Joshi · Perungudi");
    expect(b).not.toHaveProperty("attendees");
    expect(b.reminders.overrides).toEqual([{ method: "popup", minutes: 30 }]);
  });
  it("says whether you host or accompany", () => {
    expect(buildTourEventBody(base).description).toContain("You are hosting");
    expect(buildTourEventBody({ ...base, role: "accompanying" }).description).toContain("accompanying this tour, hosted by Arun K");
  });
  it("defaults to an hour when there is no usable end", () => {
    expect(buildTourEventBody({ ...base, endIso: null }).end.dateTime).toBe("2026-11-21T06:30:00.000Z");
    expect(buildTourEventBody({ ...base, endIso: "2026-11-21T05:00:00Z" }).end.dateTime).toBe("2026-11-21T06:30:00.000Z");
  });
});
