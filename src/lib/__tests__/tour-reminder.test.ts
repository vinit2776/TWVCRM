import { describe, it, expect } from "vitest";
import { tourReminderRecipients, inReminderWindow, minutesUntil, tourTimeText } from "../tour-reminder";

const priya = { id: "p", full_name: "Priya", email: "p@x.test", phone: "+911" };
const arjun = { id: "a", full_name: "Arjun", email: "a@x.test", phone: null };

describe("tourReminderRecipients", () => {
  it("includes the lead's handler, once, even when they also booked or host", () => {
    expect(tourReminderRecipients(priya, arjun, { id: "h", email: "h@x.com" }).map((p) => p.id)).toEqual(["p", "a", "h"]);
    expect(tourReminderRecipients(priya, arjun, priya).map((p) => p.id)).toEqual(["p", "a"]);
  });

  it("is the booker and the host, once each", () => {
    expect(tourReminderRecipients(priya, arjun).map((p) => p.id)).toEqual(["p", "a"]);
    expect(tourReminderRecipients(priya, priya).map((p) => p.id)).toEqual(["p"]);
  });

  it("is just the booker when there is no host, and drops anyone who cannot be reached", () => {
    expect(tourReminderRecipients(priya, null).map((p) => p.id)).toEqual(["p"]);
    expect(tourReminderRecipients(priya, { id: "z", email: null, phone: null }).map((p) => p.id)).toEqual(["p"]);
    expect(tourReminderRecipients(null, null)).toEqual([]);
  });
});

describe("reminder window", () => {
  const now = new Date("2026-11-05T05:00:00Z");
  it("opens 2 hours before the start, and closes when the tour starts", () => {
    expect(inReminderWindow("2026-11-05T07:00:00Z", now)).toBe(true); // exactly 120 min
    expect(inReminderWindow("2026-11-05T07:01:00Z", now)).toBe(false);
    expect(inReminderWindow("2026-11-05T05:30:00Z", now)).toBe(true);
    expect(inReminderWindow("2026-11-05T05:00:00Z", now)).toBe(false);
    expect(inReminderWindow("2026-11-05T04:00:00Z", now)).toBe(false); // already started: never reminded
  });

  it("counts minutes", () => {
    expect(minutesUntil("2026-11-05T06:30:00Z", now)).toBe(90);
  });
});

describe("tourTimeText", () => {
  it("is in IST", () => {
    expect(tourTimeText("2026-11-06T05:30:00Z")).toMatch(/11:00/);
  });
});
