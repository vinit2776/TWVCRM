import { describe, it, expect } from "vitest";
import { caseEndDate } from "@/lib/case-workflow";

describe("caseEndDate", () => {
  it("returns the last day of the term, not the first day after it", () => {
    // 11-month term from 17 Feb 2026 ends 16 Jan 2027.
    expect(caseEndDate("2026-02-17", 11)).toBe("2027-01-16");
  });

  it("handles a 12-month term across a year boundary", () => {
    expect(caseEndDate("2026-08-13", 12)).toBe("2027-08-12");
  });

  it("handles a short term", () => {
    expect(caseEndDate("2026-08-13", 6)).toBe("2027-02-12");
  });

  it("returns a plain date with no time component", () => {
    expect(caseEndDate("2026-02-24", 11)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null rather than inventing an expiry when start_date is missing", () => {
    expect(caseEndDate(null, 11)).toBeNull();
    expect(caseEndDate(undefined, 11)).toBeNull();
    expect(caseEndDate("", 11)).toBeNull();
  });

  it("returns null rather than inventing an expiry when tenure is missing or absurd", () => {
    expect(caseEndDate("2026-02-17", null)).toBeNull();
    expect(caseEndDate("2026-02-17", undefined)).toBeNull();
    expect(caseEndDate("2026-02-17", 0)).toBeNull();
    expect(caseEndDate("2026-02-17", -3)).toBeNull();
  });

  it("matches the backfill SQL for the real production cases", () => {
    // Same arithmetic as 00525: start_date + tenure - 1 day.
    expect(caseEndDate("2026-02-24", 11)).toBe("2027-01-23");
    expect(caseEndDate("2026-08-13", 6)).toBe("2027-02-12");
  });
});
