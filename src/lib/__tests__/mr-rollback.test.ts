import { describe, it, expect } from "vitest";
import { MR_APPROVED_STATUSES, mrStatusAfterReopen } from "../procurement/mr-rollback";

describe("mrStatusAfterReopen", () => {
  it("returns an MR to where it was cancelled from", () => {
    expect(mrStatusAfterReopen("submitted")).toBe("submitted");
    expect(mrStatusAfterReopen("draft")).toBe("draft");
  });

  it("defaults older or unexpected cancelled MRs to draft", () => {
    expect(mrStatusAfterReopen(null)).toBe("draft");
    expect(mrStatusAfterReopen(undefined)).toBe("draft");
    expect(mrStatusAfterReopen("approved")).toBe("draft");
    expect(mrStatusAfterReopen("")).toBe("draft");
  });
});

describe("MR_APPROVED_STATUSES", () => {
  it("is exactly the statuses budget treats as committed", () => {
    expect([...MR_APPROVED_STATUSES]).toEqual(["approved", "partially_ordered", "po_created"]);
  });
});
