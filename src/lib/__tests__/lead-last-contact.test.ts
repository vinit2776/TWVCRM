import { describe, it, expect } from "vitest";
import { isLastContactActivity } from "../lead-last-contact";

describe("isLastContactActivity", () => {
  it("counts calls, tours and meetings", () => {
    expect(isLastContactActivity({ type: "call", subject: "Spoke" })).toBe(true);
    expect(isLastContactActivity({ type: "call", subject: "No answer" })).toBe(true);
    expect(isLastContactActivity({ type: "tour", subject: "Tour booked" })).toBe(true);
    expect(isLastContactActivity({ type: "meeting", subject: null })).toBe(true);
  });

  it("counts a logged quote, but not an automatic email", () => {
    expect(isLastContactActivity({ type: "email", subject: "Quote sent" })).toBe(true);
    expect(isLastContactActivity({ type: "email", subject: "Booking confirmation sent for TWV-B-0288" })).toBe(false);
    expect(isLastContactActivity({ type: "email", subject: null })).toBe(false);
  });

  it("ignores notes, including the bookkeeping ones", () => {
    expect(isLastContactActivity({ type: "note", subject: "Follow-up closed" })).toBe(false);
    expect(isLastContactActivity({ type: "note", subject: "Not interested" })).toBe(false);
  });
});
