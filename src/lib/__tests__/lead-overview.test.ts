import { describe, it, expect } from "vitest";
import { buildOverview, median, formatWait, type OverviewLead } from "../lead-overview";

const NOW = new Date("2026-11-04T10:00:00Z");
const ago = (days: number, mins = 0) => new Date(NOW.getTime() - days * 86400000 - mins * 60000).toISOString();
let n = 0;
const lead = (o: Partial<OverviewLead>): OverviewLead => ({
  id: `l${++n}`, leadNumber: n, name: `Lead ${n}`, company: null, status: "contacted", source: "meta_ads",
  workspaceType: "dedicated_desk", seats: 2, budgetPerSeat: 6000, locationId: "kor", locationName: "Koramangala",
  assignedTo: "u1", assigneeName: "Priya", createdAt: ago(2), archivedAt: null, firstResponseAt: null, overdueDays: null, themes: [],
  ...o,
});
const base = {
  now: NOW, windowDays: 30, rate: () => 12000, ourRate: 12000,
  labelSource: (k: string) => k, labelType: (k: string) => k,
};

describe("buildOverview", () => {
  const leads = [
    lead({ seats: 8, workspaceType: "private_office", budgetPerSeat: 12000, assignedTo: null, assigneeName: null, createdAt: ago(0, 12), company: "Nair Labs", source: "google_ads", themes: ["tour"] }),
    lead({ seats: 6, workspaceType: "dedicated_desk", budgetPerSeat: 12000, overdueDays: 2, source: "inbound_call" }),
    lead({ seats: 1, workspaceType: "hot_desk", budgetPerSeat: 5000, source: "meta_ads", status: "new", assignedTo: null, assigneeName: null }),
    lead({ status: "won", seats: 4, budgetPerSeat: 9000, createdAt: ago(5), firstResponseAt: ago(5, -30) }),
    lead({ status: "lost", createdAt: ago(10) }),
    lead({ createdAt: ago(40), locationId: "ind", locationName: "Indiranagar" }),
  ];

  it("counts what to act on now, biggest first", () => {
    const o = buildOverview({ ...base, leads, locationId: null });
    expect(o.cards.actNow).toBe(2);
    expect(o.focus.map((f) => f.monthly)).toEqual([96000, 72000]);
    expect(o.focus[0].unclaimedMinutes).toBe(12);
    expect(o.focus[1].overdueDays).toBe(2);
  });

  it("totals the open pipeline and the unclaimed queue", () => {
    const o = buildOverview({ ...base, leads, locationId: null });
    expect(o.cards.waiting).toBe(2);
    expect(o.cards.oldestWaitingMinutes).toBe(2 * 24 * 60);
    expect(o.cards.passing).toBe(2);
    expect(o.cards.pipeline).toBe(96000 + 72000 + 5000 + 12000);
  });

  it("gives no profile for all locations, a full one for a single location", () => {
    expect(buildOverview({ ...base, leads, locationId: null }).profile).toBeNull();
    const p = buildOverview({ ...base, leads, locationId: "kor" }).profile!;
    expect(p.enquiries).toBe(5);
    expect(p.won).toBe(1);
    expect(p.stillOpen).toBe(3);
    expect(p.medianResponseMinutes).toBe(30);
    expect(p.requests).toEqual([{ key: "tour", label: "Tour / visit", count: 1 }]);
    expect(p.budgetBase).toBe(5);
    expect(p.seatBands.find((b) => b.key === "10+")?.count).toBe(0);
  });

  it("compares with the previous window", () => {
    const p = buildOverview({ ...base, leads: [...leads, lead({ createdAt: ago(45) }), lead({ createdAt: ago(50) })], locationId: "kor" }).profile!;
    expect(p.previous).toBe(2);
  });
});

describe("helpers", () => {
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([2, 4])).toBe(3);
  });
  it("formatWait", () => {
    expect(formatWait(47)).toBe("47 min");
    expect(formatWait(185)).toBe("3 h 5 min");
    expect(formatWait(2880)).toBe("2 days");
    expect(formatWait(null)).toBe("—");
  });
});
