import { describe, it, expect } from "vitest";
import {
  OVERDUE_REVIEW_DAYS,
  canActOnPileLead,
  daysOverdue,
  newDateProblem,
  parseReviewMode,
  reviewPile,
  snoozedTo,
} from "../lead-overdue-review";

const NOW = new Date("2026-11-22T06:00:00Z"); // 11:30 IST on 22 Nov

describe("daysOverdue", () => {
  it("counts whole IST days past due", () => {
    expect(daysOverdue("2026-11-08T06:00:00Z", NOW)).toBe(14);
    expect(daysOverdue("2026-11-21T18:00:00Z", NOW)).toBe(1); // 23:30 IST on the 21st is yesterday
  });
  it("is zero or negative when due today or later", () => {
    expect(daysOverdue("2026-11-22T10:00:00Z", NOW)).toBe(0);
    expect(daysOverdue("2026-11-25T10:00:00Z", NOW)).toBe(-3);
  });
});

describe("reviewPile", () => {
  it("holds leads 14 or more days overdue, most overdue first", () => {
    const pile = reviewPile(
      new Map([
        ["a", "2026-11-09T06:00:00Z"], // 13 days: not yet
        ["b", "2026-11-08T06:00:00Z"], // 14 days
        ["c", "2026-10-01T06:00:00Z"], // 52 days
        ["d", "2026-11-30T06:00:00Z"], // future
      ]),
      NOW,
    );
    expect(pile.map((r) => r.leadId)).toEqual(["c", "b"]);
    expect(pile[1].daysOverdue).toBe(OVERDUE_REVIEW_DAYS);
  });
  it("is empty when nothing is that late", () => {
    expect(reviewPile(new Map([["a", "2026-11-20T06:00:00Z"]]), NOW)).toEqual([]);
  });
});

describe("canActOnPileLead", () => {
  it("lets admins and managers act on any lead", () => {
    expect(canActOnPileLead("admin", "me", "someone")).toBe(true);
    expect(canActOnPileLead("manager", "me", null)).toBe(true);
  });
  it("lets others act only on their own leads", () => {
    expect(canActOnPileLead("sales_rep", "me", "me")).toBe(true);
    expect(canActOnPileLead("sales_rep", "me", "someone")).toBe(false);
    expect(canActOnPileLead("sales_rep", "me", null)).toBe(false);
  });
});

describe("parseReviewMode", () => {
  it("falls back to the safe preview mode", () => {
    expect(parseReviewMode(undefined)).toBe("dry_run");
    expect(parseReviewMode("yes")).toBe("dry_run");
    expect(parseReviewMode("live")).toBe("live");
    expect(parseReviewMode("off")).toBe("off");
  });
});

describe("dates", () => {
  it("snoozes a week ahead", () => {
    expect(snoozedTo(NOW)).toBe("2026-11-29T06:00:00.000Z");
  });
  it("wants a new date after today", () => {
    expect(newDateProblem(null, NOW)).toBe("Pick the new date");
    expect(newDateProblem("nonsense", NOW)).toBe("That date is not valid");
    expect(newDateProblem("2026-11-22T10:00:00Z", NOW)).toBe("Pick a date after today");
    expect(newDateProblem("2026-11-23T10:00:00Z", NOW)).toBeNull();
  });
});
