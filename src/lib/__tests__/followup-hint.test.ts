import { describe, it, expect } from "vitest";
import { suggestFollowUp, followUpInDays } from "../followup-hint";

// Wednesday 4 Nov 2026, 10:12 IST
const NOW = new Date("2026-11-04T10:12:00+05:30");

describe("suggestFollowUp", () => {
  it("reads a weekday and a time", () => {
    expect(suggestFollowUp("Call me Friday 4pm with pricing", NOW)).toBe("2026-11-06T16:00");
  });

  it("treats the same weekday as next week", () => {
    expect(suggestFollowUp("let's talk wednesday", NOW)).toBe("2026-11-11T11:00");
  });

  it("reads tomorrow and defaults to 11am", () => {
    expect(suggestFollowUp("wants a revised quote tomorrow", NOW)).toBe("2026-11-05T11:00");
  });

  it("reads a calendar date, rolling to next year once it has passed", () => {
    expect(suggestFollowUp("call me after 1 Jan", NOW)).toBe("2027-01-01T11:00");
    expect(suggestFollowUp("visit on 20th November at 3:30pm", NOW)).toBe("2026-11-20T15:30");
  });

  it("reads 'in N days' and 'next week'", () => {
    expect(suggestFollowUp("ring in 3 days", NOW)).toBe("2026-11-07T11:00");
    expect(suggestFollowUp("busy, try next week", NOW)).toBe("2026-11-09T11:00");
  });

  it("keeps the time inside the pickable 9am-8pm slots", () => {
    expect(suggestFollowUp("tomorrow 11pm", NOW)).toBe("2026-11-05T20:00");
    expect(suggestFollowUp("tomorrow 7am", NOW)).toBe("2026-11-05T09:00");
  });

  it("returns null when the note names no date, or the time has already gone", () => {
    expect(suggestFollowUp("interested in 6 seats", NOW)).toBeNull();
    expect(suggestFollowUp("today 9am", NOW)).toBeNull();
  });
});

describe("followUpInDays", () => {
  it("lands 48 hours later, rounded up to the next half hour", () => {
    expect(followUpInDays(2, NOW)).toBe("2026-11-06T10:30");
  });

  it("pulls an out-of-hours time into the working slots", () => {
    expect(followUpInDays(2, new Date("2026-11-04T22:40:00+05:30"))).toBe("2026-11-06T20:00");
    expect(followUpInDays(2, new Date("2026-11-04T06:05:00+05:30"))).toBe("2026-11-06T09:00");
  });
});
