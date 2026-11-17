import { describe, it, expect } from "vitest";
import { addDaysKey, weekOf, bucketByDay, istRange, type CalendarItem } from "../lead-calendar";

const item = (id: string, at: string): CalendarItem => ({
  id, leadId: "l", leadName: "n", at, what: "w", type: "call", handler: null, pinned: false,
});

describe("weekOf", () => {
  it("runs Monday to Sunday around any day in the week", () => {
    // Wed 4 Nov 2026
    expect(weekOf("2026-11-04")).toEqual([
      "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08",
    ]);
    // A Sunday belongs to the week that started the Monday before
    expect(weekOf("2026-11-08")[0]).toBe("2026-11-02");
    expect(weekOf("2026-11-02")[6]).toBe("2026-11-08");
  });
});

describe("addDaysKey", () => {
  it("crosses month and year ends", () => {
    expect(addDaysKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("bucketByDay", () => {
  it("puts a late-evening IST item on its IST day and sorts each day by time", () => {
    const buckets = bucketByDay([
      item("b", "2026-11-04T11:00:00Z"),
      item("a", "2026-11-04T04:30:00Z"),
      item("late", "2026-11-04T19:00:00Z"), // 00:30 IST on 5 Nov
    ]);
    expect(buckets["2026-11-04"].map((i) => i.id)).toEqual(["a", "b"]);
    expect(buckets["2026-11-05"].map((i) => i.id)).toEqual(["late"]);
  });
});

describe("istRange", () => {
  it("covers whole IST days", () => {
    expect(istRange("2026-11-04", "2026-11-04")).toEqual({
      start: "2026-11-03T18:30:00.000Z",
      end: "2026-11-04T18:30:00.000Z",
    });
  });
});
