import { describe, expect, it } from "vitest";
import { conversationText, lastTenDigits, rowPrimaryAction } from "@/lib/enquiry-row";

const base = { resolvedAt: null, isSpam: false, needsReview: false, claimedAt: null };

describe("rowPrimaryAction", () => {
  it("asks for a decision first", () => {
    expect(rowPrimaryAction({ ...base, needsReview: true })).toBe("review");
    expect(rowPrimaryAction({ ...base, needsReview: true, claimedAt: "x" })).toBe("review");
  });
  it("offers to take an unclaimed enquiry and to log on a claimed one", () => {
    expect(rowPrimaryAction(base)).toBe("take");
    expect(rowPrimaryAction({ ...base, claimedAt: "2026-10-20" })).toBe("log");
  });
  it("just opens finished and spam rows", () => {
    expect(rowPrimaryAction({ ...base, resolvedAt: "2026-10-20" })).toBe("open");
    expect(rowPrimaryAction({ ...base, isSpam: true, needsReview: true })).toBe("open");
  });
});

describe("conversationText", () => {
  it("falls back to the template name", () => {
    expect(conversationText({ message_body: " hi ", template_name: null })).toBe("hi");
    expect(conversationText({ message_body: "", template_name: "complaint_received" })).toBe("[complaint_received]");
    expect(conversationText({ message_body: null, template_name: null })).toBe("[no text]");
  });
});

describe("lastTenDigits", () => {
  it("keys numbers by their last 10 digits", () => {
    expect(lastTenDigits("+91 98765-43210")).toBe("9876543210");
    expect(lastTenDigits("12345")).toBeNull();
    expect(lastTenDigits(null)).toBeNull();
  });
});
