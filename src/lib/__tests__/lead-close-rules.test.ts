import { describe, it, expect } from "vitest";
import { lostReasonMissing } from "../lead-close-rules";

const base = { oldStatus: "contacted", oldLostReason: null, newStatus: "lost", newLostReason: null };

describe("lostReasonMissing", () => {
  it("refuses a move to lost with no reason", () => {
    expect(lostReasonMissing(base)).toBe(true);
    expect(lostReasonMissing({ ...base, newLostReason: "  " })).toBe(true);
  });
  it("accepts a reason given now or already on the lead", () => {
    expect(lostReasonMissing({ ...base, newLostReason: "budget" })).toBe(false);
    expect(lostReasonMissing({ ...base, oldLostReason: "timing" })).toBe(false);
  });
  it("leaves an already-lost lead editable with no reason", () => {
    expect(lostReasonMissing({ ...base, oldStatus: "lost" })).toBe(false);
  });
  it("ignores other status changes", () => {
    expect(lostReasonMissing({ ...base, newStatus: "contacted" })).toBe(false);
    expect(lostReasonMissing({ ...base, newStatus: undefined })).toBe(false);
  });
});
