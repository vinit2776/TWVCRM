import { describe, expect, it } from "vitest";
import {
  ageDaysUrgency,
  countUrgency,
  dueDateUrgency,
  inboxUrgency,
  sortQueue,
  tdsDueDate,
  tdsUrgency,
  todayIST,
  type QueueItem,
} from "../accounts-queue";

const item = (over: Partial<QueueItem>): QueueItem => ({
  key: "k",
  type: "inv",
  title: "A",
  subtitle: "",
  href: "/x",
  urgency: "today",
  daysLate: 0,
  ...over,
});

describe("todayIST", () => {
  it("rolls to the next day after 18:30 UTC", () => {
    expect(todayIST(new Date("2026-10-26T18:29:00Z"))).toBe("2026-10-26");
    expect(todayIST(new Date("2026-10-26T18:31:00Z"))).toBe("2026-10-27");
  });
});

describe("inboxUrgency", () => {
  it("turns overdue at 48 hours", () => {
    expect(inboxUrgency(47)).toEqual({ urgency: "today", daysLate: 0 });
    expect(inboxUrgency(48)).toEqual({ urgency: "overdue", daysLate: 2 });
    expect(inboxUrgency(150)).toEqual({ urgency: "overdue", daysLate: 6 });
  });
});

describe("dueDateUrgency", () => {
  it("is overdue only after the date has passed", () => {
    expect(dueDateUrgency("2026-10-26", "2026-10-26").urgency).toBe("today");
    expect(dueDateUrgency("2026-10-24", "2026-10-26")).toEqual({ urgency: "overdue", daysLate: 2 });
  });
  it("treats a missing date as today", () => {
    expect(dueDateUrgency(null, "2026-10-26")).toEqual({ urgency: "today", daysLate: 0 });
  });
});

describe("ageDaysUrgency", () => {
  it("uses the given threshold", () => {
    expect(ageDaysUrgency("2026-10-25T10:00:00Z", "2026-10-26", 2).urgency).toBe("today");
    expect(ageDaysUrgency("2026-10-24T10:00:00Z", "2026-10-26", 2)).toEqual({ urgency: "overdue", daysLate: 2 });
  });
});

describe("TDS", () => {
  it("is due on the 7th of the next month, 30 April for March, across the year end", () => {
    expect(tdsDueDate(10, 2026)).toBe("2026-11-07");
    expect(tdsDueDate(12, 2026)).toBe("2027-01-07");
    expect(tdsDueDate(3, 2027)).toBe("2027-04-30");
  });
  it("stays out of the queue until a week before", () => {
    expect(tdsUrgency(10, 2026, "2026-10-26")).toBeNull();
    expect(tdsUrgency(10, 2026, "2026-10-31")).toMatchObject({ urgency: "today", daysLeft: 7 });
    expect(tdsUrgency(10, 2026, "2026-11-09")).toMatchObject({ urgency: "overdue", daysLate: 2 });
  });
});

describe("sortQueue and countUrgency", () => {
  it("puts the most late first and counts each urgency", () => {
    const items = [
      item({ key: "a", title: "B", urgency: "today" }),
      item({ key: "b", title: "C", urgency: "overdue", daysLate: 2 }),
      item({ key: "c", title: "D", urgency: "overdue", daysLate: 6 }),
      item({ key: "d", title: "A", urgency: "today" }),
    ];
    expect(sortQueue(items).map((i) => i.key)).toEqual(["c", "b", "d", "a"]);
    expect(countUrgency(items)).toEqual({ overdue: 2, today: 2 });
  });
});
