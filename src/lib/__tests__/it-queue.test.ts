import { describe, expect, it } from "vitest";
import {
  countItUrgency,
  issueUrgency,
  onboardingUrgency,
  rowsForTile,
  sortItQueue,
  teamLoad,
  tileCounts,
  type ItQueueItem,
} from "../it-queue";

const item = (over: Partial<ItQueueItem>): ItQueueItem => ({
  key: "k",
  type: "tkt",
  title: "A",
  subtitle: "",
  href: "/x",
  urgency: "today",
  daysLate: 0,
  ...over,
});

describe("onboardingUrgency", () => {
  it("turns overdue two days after activation, counted on the IST calendar", () => {
    expect(onboardingUrgency("2026-10-26T10:00:00Z", "2026-10-27").urgency).toBe("today");
    expect(onboardingUrgency("2026-10-25T10:00:00Z", "2026-10-27")).toEqual({ urgency: "overdue", daysLate: 2 });
    // 19:00 UTC on the 25th is already the 26th in IST, so only one day has passed.
    expect(onboardingUrgency("2026-10-25T19:00:00Z", "2026-10-27").urgency).toBe("today");
  });
});

describe("issueUrgency", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  const today = "2026-10-27";

  it("is overdue once the target has passed, in hours first then days", () => {
    expect(issueUrgency("2026-10-27T05:00:00Z", false, now, today)).toMatchObject({ urgency: "overdue", chip: "5h late" });
    expect(issueUrgency("2026-10-24T05:00:00Z", false, now, today)).toMatchObject({
      urgency: "overdue",
      daysLate: 3,
      chip: "3d late",
    });
  });

  it("trusts a breached flag even when the target looks fine", () => {
    expect(issueUrgency("2026-10-27T20:00:00Z", true, now, today)?.urgency).toBe("overdue");
  });

  it("is due today when the target is later today, and out of the queue when it is later still", () => {
    expect(issueUrgency("2026-10-27T12:00:00Z", false, now, today)).toEqual({ urgency: "today", daysLate: 0 });
    expect(issueUrgency("2026-10-29T12:00:00Z", false, now, today)).toBeNull();
  });

  it("treats a missing target as due today", () => {
    expect(issueUrgency(null, false, now, today)).toEqual({ urgency: "today", daysLate: 0 });
  });
});

describe("queue ordering and counts", () => {
  const items = [
    item({ key: "a", title: "B", urgency: "today" }),
    item({ key: "b", title: "C", urgency: "overdue", daysLate: 2 }),
    item({ key: "c", title: "D", urgency: "overdue", daysLate: 6 }),
    item({ key: "d", title: "A", urgency: "today" }),
    item({ key: "w", title: "Z", urgency: "overdue", daysLate: 9, blockedBy: "Waiting on sales" }),
  ];

  it("puts the most late first and blocked rows last", () => {
    expect(sortItQueue(items).map((i) => i.key)).toEqual(["c", "b", "d", "a", "w"]);
  });

  it("does not count blocked rows", () => {
    expect(countItUrgency(items)).toEqual({ overdue: 2, today: 2 });
  });
});

describe("tiles", () => {
  const items = [
    item({ key: "1", type: "vch", customerKey: "x", urgency: "overdue", daysLate: 3 }),
    item({ key: "2", type: "crd", customerKey: "x", urgency: "today" }),
    item({ key: "3", type: "vch", customerKey: "y", urgency: "today" }),
    item({ key: "4", type: "tkt", urgency: "overdue", daysLate: 1 }),
    item({ key: "5", type: "vch", customerKey: "z", urgency: "overdue", blockedBy: "Waiting on sales" }),
  ];

  it("counts a customer once on the onboarding tile, overdue if any of their steps is", () => {
    expect(tileCounts(items, "onb")).toEqual({ total: 2, overdue: 1 });
  });

  it("counts rows on the other tiles and ignores blocked ones", () => {
    expect(tileCounts(items, "vch")).toEqual({ total: 2, overdue: 1 });
    expect(tileCounts(items, "tkt")).toEqual({ total: 1, overdue: 1 });
  });

  it("filters rows by tile, with onboarding meaning every customer-linked row", () => {
    expect(rowsForTile(items, "onb").map((i) => i.key)).toEqual(["1", "2", "3", "5"]);
    expect(rowsForTile(items, "crd").map((i) => i.key)).toEqual(["2"]);
    expect(rowsForTile(items, null)).toHaveLength(5);
  });
});

describe("teamLoad", () => {
  it("groups by person, busiest first, with unassigned work last", () => {
    const rows = teamLoad([
      { assigneeName: "Asha", overdue: true },
      { assigneeName: null, overdue: false },
      { assigneeName: "Ravi", overdue: false },
      { assigneeName: "Ravi", overdue: true },
    ]);
    expect(rows).toEqual([
      { name: "Ravi", open: 2, overdue: 1 },
      { name: "Asha", open: 1, overdue: 1 },
      { name: "Not assigned", open: 1, overdue: 0 },
    ]);
  });
});
