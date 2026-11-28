import { describe, expect, it } from "vitest";
import { ENQUIRY_VIEWER_WINDOW_DAYS, enquiryViewerFrom } from "../restricted-roles";

const now = new Date("2026-11-28T10:00:00Z");
const floor = new Date(now.getTime() - ENQUIRY_VIEWER_WINDOW_DAYS * 86_400_000).toISOString();

describe("enquiryViewerFrom", () => {
  it("defaults to the window start", () => {
    expect(enquiryViewerFrom(null, now)).toBe(floor);
  });
  it("never reaches further back than the window, however old a date is asked for", () => {
    expect(enquiryViewerFrom("2025-01-01", now)).toBe(floor);
  });
  it("lets a recent date narrow the view", () => {
    expect(enquiryViewerFrom("2026-11-20", now)).toBe(new Date("2026-11-20").toISOString());
  });
  it("ignores an unreadable date", () => {
    expect(enquiryViewerFrom("not-a-date", now)).toBe(floor);
  });
});
