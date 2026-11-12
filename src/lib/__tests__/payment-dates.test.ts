import { describe, it, expect } from "vitest";
import { daysAgoLabel, formatLongDate, formatRecordedOn, isFutureDate, todayIst } from "../payment-dates";

// 16 Oct 2026, 01:00 IST == 15 Oct 19:30 UTC: the two zones disagree on the date.
const NOW = new Date("2026-10-15T19:30:00Z");

describe("todayIst", () => {
  it("uses India's calendar day, not UTC's", () => {
    expect(todayIst(NOW)).toBe("2026-10-16");
  });
});

describe("isFutureDate", () => {
  it("accepts today and the past in IST", () => {
    expect(isFutureDate("2026-10-16", NOW)).toBe(false);
    expect(isFutureDate("2026-10-01", NOW)).toBe(false);
  });
  it("rejects a bank date after today", () => {
    expect(isFutureDate("2026-10-17", NOW)).toBe(true);
  });
  it("ignores malformed input rather than treating it as future", () => {
    expect(isFutureDate("", NOW)).toBe(false);
    expect(isFutureDate("tomorrow", NOW)).toBe(false);
  });
});

describe("formatLongDate", () => {
  it("renders the exact calendar day with no timezone drift", () => {
    expect(formatLongDate("2026-10-01")).toContain("1 Oct 2026");
    expect(formatLongDate("2026-10-01")).toContain("Thu");
  });
  it("passes through junk unchanged", () => {
    expect(formatLongDate("nope")).toBe("nope");
  });
});

describe("daysAgoLabel", () => {
  it("labels today, yesterday and older days in IST calendar days", () => {
    expect(daysAgoLabel("2026-10-16", NOW)).toBe("today");
    expect(daysAgoLabel("2026-10-15", NOW)).toBe("yesterday");
    expect(daysAgoLabel("2026-10-01", NOW)).toBe("15 days ago");
  });
});

describe("formatRecordedOn", () => {
  it("shows the IST date of the instant", () => {
    expect(formatRecordedOn("2026-10-15T19:30:00Z")).toContain("16 Oct 2026");
  });
  it("shows a dash when there is no timestamp", () => {
    expect(formatRecordedOn(null)).toBe("—");
    expect(formatRecordedOn("")).toBe("—");
  });
});
