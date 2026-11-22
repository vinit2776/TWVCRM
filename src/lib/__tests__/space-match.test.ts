import { describe, it, expect } from "vitest";
import { freeUnits, matchParked, parseMatchMode, unitTypesFor, type SpaceAllocation, type SpaceUnit } from "../space-match";

const unit = (id: string, type: SpaceUnit["type"], capacity: number, loc = "L1", isActive = true): SpaceUnit => ({ id, locationId: loc, type, capacity, isActive });
const alloc = (unitId: string, startDate: string, endDate: string | null, status: "active" | "ended" = "active"): SpaceAllocation => ({ unitId, startDate, endDate, status });

describe("unitTypesFor", () => {
  it("maps what a lead wants to the kind of unit", () => {
    expect(unitTypesFor("private_office")).toEqual(["private_cabin"]);
    expect(unitTypesFor("managed")).toEqual(["managed_office"]);
    expect(unitTypesFor(null)).toBe("any");
    expect(unitTypesFor("virtual_office")).toBe("none");
    expect(unitTypesFor("meeting_room")).toBe("none");
  });
});

describe("freeUnits", () => {
  const u = [unit("a", "private_cabin", 4)];
  it("is free with no allocation, and after an allocation ended or lapsed", () => {
    expect(freeUnits(u, [], "2026-12-01")).toHaveLength(1);
    expect(freeUnits(u, [alloc("a", "2026-01-01", null, "ended")], "2026-12-01")).toHaveLength(1);
    expect(freeUnits(u, [alloc("a", "2026-01-01", "2026-11-30")], "2026-12-01")).toHaveLength(1);
  });
  it("is taken while an active allocation covers the start date", () => {
    expect(freeUnits(u, [alloc("a", "2026-01-01", null)], "2026-12-01")).toHaveLength(0);
    expect(freeUnits(u, [alloc("a", "2026-01-01", "2026-12-01")], "2026-12-01")).toHaveLength(0);
  });
  it("is not free if it is taken again within a month of the start date", () => {
    expect(freeUnits(u, [alloc("a", "2026-12-15", null)], "2026-12-01")).toHaveLength(0);
    expect(freeUnits(u, [alloc("a", "2027-02-01", null)], "2026-12-01")).toHaveLength(1);
  });
  it("never counts an inactive unit", () => {
    expect(freeUnits([unit("a", "private_cabin", 4, "L1", false)], [], "2026-12-01")).toHaveLength(0);
  });
});

describe("matchParked", () => {
  const units = [unit("c1", "private_cabin", 4), unit("c2", "private_cabin", 8, "L2"), unit("d1", "hot_desk", 1), unit("d2", "hot_desk", 1), unit("d3", "hot_desk", 1), unit("b1", "business_centre", 10)];
  const want = (over: Partial<{ locationId: string | null; workspaceType: string | null; seatsNeeded: number | null }> = {}) => ({ locationId: "L1", workspaceType: "private_office", seatsNeeded: 4, ...over });

  it("matches a cabin big enough at the same centre", () => {
    const r = matchParked(want(), units, [], "2026-12-01", "Perungudi");
    expect(r.matched).toBe(true);
    expect(r.note).toContain("at Perungudi");
  });
  it("does not match a cabin that is too small, or at another centre", () => {
    expect(matchParked(want({ seatsNeeded: 6 }), units, [], "2026-12-01").matched).toBe(false);
    expect(matchParked(want({ locationId: "L3" }), units, [], "2026-12-01").matched).toBe(false);
  });
  it("needs the whole group in one cabin, but desks can add up", () => {
    const two = [unit("c1", "private_cabin", 2), unit("c2", "private_cabin", 2)];
    expect(matchParked(want({ seatsNeeded: 4 }), two, [], "2026-12-01").matched).toBe(false);
    expect(matchParked(want({ workspaceType: "hot_desk", seatsNeeded: 3 }), units, [], "2026-12-01").matched).toBe(true);
    expect(matchParked(want({ workspaceType: "hot_desk", seatsNeeded: 4 }), units, [], "2026-12-01").matched).toBe(false);
  });
  it("sees an end date: a cabin freed after their start date does not match yet", () => {
    expect(matchParked(want(), units, [alloc("c1", "2026-01-01", "2026-12-20")], "2026-12-01").matched).toBe(false);
    expect(matchParked(want(), units, [alloc("c1", "2026-01-01", "2026-12-20")], "2026-12-21").matched).toBe(true);
  });
  it("never matches an area with no centre, a type with no unit, or hourly business centre space", () => {
    expect(matchParked(want({ locationId: null }), units, [], "2026-12-01").matched).toBe(false);
    expect(matchParked(want({ workspaceType: "virtual_office" }), units, [], "2026-12-01").matched).toBe(false);
    expect(matchParked(want({ workspaceType: null, seatsNeeded: 10 }), [unit("b1", "business_centre", 10)], [], "2026-12-01").matched).toBe(false);
  });
  it("treats missing seats as one", () => {
    expect(matchParked(want({ seatsNeeded: null }), units, [], "2026-12-01").matched).toBe(true);
  });
});

describe("parseMatchMode", () => {
  it("reads an unknown value as the safe preview", () => {
    expect(parseMatchMode(undefined)).toBe("dry_run");
    expect(parseMatchMode("live")).toBe("live");
    expect(parseMatchMode("off")).toBe("off");
  });
});
