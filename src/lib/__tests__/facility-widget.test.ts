import { describe, it, expect } from "vitest";
import {
  ageBand,
  applyFilter,
  expectedDayOffset,
  fmtHours,
  hoursToSla,
  inLane,
  isDueToday,
  normaliseScope,
  slaState,
  type FacilityFilter,
  type FacilityWidgetItem,
} from "../facility-widget";

// 9 Oct 2026, 10:00 IST (04:30Z) — "today" is the 9th in India.
const NOW = Date.parse("2026-10-09T04:30:00Z");
const H = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * H).toISOString();

const item = (over: Partial<FacilityWidgetItem> = {}): FacilityWidgetItem => ({
  id: "i1",
  number: "FM-1",
  title: "AC not cooling",
  scope: "hvac",
  priority: "medium",
  status: "in_progress",
  kind: "ticket",
  location: "Location A",
  assignee: "Ravi",
  reported_at: at(-10),
  last_activity: at(-1),
  resolved_at: null,
  sla_target_at: at(20),
  ...over,
});

const filter = (over: Partial<FacilityFilter> = {}): FacilityFilter => ({ kind: "all", lane: "pending", scope: null, ageBand: null, day: null, ...over });

describe("slaState — computed from the SLA time, not a stored flag", () => {
  it("is breached once the SLA time has passed", () => {
    expect(slaState(item({ sla_target_at: at(-0.5) }), NOW)).toBe("breached");
  });
  it("is due soon inside the 6h window", () => {
    expect(slaState(item({ sla_target_at: at(5) }), NOW)).toBe("due_soon");
    expect(slaState(item({ sla_target_at: at(6) }), NOW)).toBe("due_soon");
  });
  it("is on track beyond 6h", () => {
    expect(slaState(item({ sla_target_at: at(7) }), NOW)).toBe("on_track");
  });
  it("has no SLA state without a target, and is never breached", () => {
    const i = item({ sla_target_at: null });
    expect(slaState(i, NOW)).toBe("no_sla");
    expect(hoursToSla(i, NOW)).toBeNull();
  });
  it("is closed once resolved, even if the SLA time has passed", () => {
    expect(slaState(item({ status: "resolved", sla_target_at: at(-50) }), NOW)).toBe("closed");
  });
});

describe("due today / expected strip use the IST calendar day", () => {
  it("due later today (IST) counts as today and is not breached", () => {
    // 22:00 IST today = 16:30Z
    const i = item({ sla_target_at: "2026-10-09T16:30:00Z" });
    expect(isDueToday(i, NOW)).toBe(true);
    expect(expectedDayOffset(i, NOW)).toBe(0);
  });
  it("a due time just past IST midnight is tomorrow even though it is still the 9th in UTC", () => {
    // 00:30 IST on the 10th = 19:00Z on the 9th
    const i = item({ sla_target_at: "2026-10-09T19:00:00Z" });
    expect(expectedDayOffset(i, NOW)).toBe(1);
    expect(isDueToday(i, NOW)).toBe(false);
  });
  it("covers today through six days out, and nothing beyond", () => {
    expect(expectedDayOffset(item({ sla_target_at: at(24 * 6) }), NOW)).toBe(6);
    expect(expectedDayOffset(item({ sla_target_at: at(24 * 8) }), NOW)).toBeNull();
  });
  it("excludes breached, closed and no-SLA items", () => {
    expect(expectedDayOffset(item({ sla_target_at: at(-1) }), NOW)).toBeNull();
    expect(expectedDayOffset(item({ status: "resolved" }), NOW)).toBeNull();
    expect(expectedDayOffset(item({ sla_target_at: null }), NOW)).toBeNull();
  });
});

describe("lanes", () => {
  it("separates open from done", () => {
    expect(inLane("pending", item({ status: "new" }), NOW)).toBe(true);
    expect(inLane("pending", item({ status: "resolved" }), NOW)).toBe(false);
    expect(inLane("done", item({ status: "closed" }), NOW)).toBe(true);
  });
  it("maps status lanes", () => {
    expect(inLane("new", item({ status: "new" }), NOW)).toBe(true);
    expect(inLane("in_progress", item({ status: "in_progress" }), NOW)).toBe(true);
    expect(inLane("reopened", item({ status: "reopened" }), NOW)).toBe(true);
    expect(inLane("new", item({ status: "acknowledged" }), NOW)).toBe(false);
  });
  it("a reopened issue still counts as open", () => {
    expect(inLane("pending", item({ status: "reopened" }), NOW)).toBe(true);
  });
});

describe("ageBand", () => {
  it("bands by hours since reported", () => {
    expect(ageBand({ reported_at: at(-5) }, NOW)).toBe(0);
    expect(ageBand({ reported_at: at(-30) }, NOW)).toBe(1);
    expect(ageBand({ reported_at: at(-100) }, NOW)).toBe(2);
    expect(ageBand({ reported_at: at(-200) }, NOW)).toBe(3);
  });
});

describe("applyFilter", () => {
  const a = item({ id: "a", kind: "ticket", scope: "hvac", last_activity: at(-1) });
  const b = item({ id: "b", kind: "task", scope: "it", last_activity: at(-5) });
  const c = item({ id: "c", kind: "ticket", scope: "hvac", status: "resolved", resolved_at: at(-2), last_activity: at(-2) });
  const all = [b, c, a];

  it("orders the feed by most recent activity", () => {
    expect(applyFilter(all, filter(), NOW).map((i) => i.id)).toEqual(["a", "b"]);
  });
  it("filters by kind and scope", () => {
    expect(applyFilter(all, filter({ kind: "task" }), NOW).map((i) => i.id)).toEqual(["b"]);
    expect(applyFilter(all, filter({ scope: "hvac" }), NOW).map((i) => i.id)).toEqual(["a"]);
  });
  it("the done lane lists resolved items", () => {
    expect(applyFilter(all, filter({ lane: "done" }), NOW).map((i) => i.id)).toEqual(["c"]);
  });
  it("orders the breached lane by how overdue, worst first", () => {
    const x = item({ id: "x", sla_target_at: at(-2) });
    const y = item({ id: "y", sla_target_at: at(-30) });
    expect(applyFilter([x, y], filter({ lane: "breached" }), NOW).map((i) => i.id)).toEqual(["y", "x"]);
  });
  it("filters by expected day", () => {
    const today = item({ id: "t", sla_target_at: "2026-10-09T16:30:00Z" });
    const tomorrow = item({ id: "m", sla_target_at: "2026-10-10T10:00:00Z" });
    expect(applyFilter([today, tomorrow], filter({ day: 1 }), NOW).map((i) => i.id)).toEqual(["m"]);
  });
});

describe("helpers", () => {
  it("formats spans", () => {
    expect(fmtHours(0.5)).toBe("30m");
    expect(fmtHours(5)).toBe("5h");
    expect(fmtHours(72)).toBe("3d");
    expect(fmtHours(-5)).toBe("5h");
  });
  it("buckets unknown scopes as other", () => {
    expect(normaliseScope("hvac")).toBe("hvac");
    expect(normaliseScope("whatever")).toBe("other");
    expect(normaliseScope(null)).toBe("other");
  });
});
