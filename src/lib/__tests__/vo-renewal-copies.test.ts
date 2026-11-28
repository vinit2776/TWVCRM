import { describe, it, expect } from "vitest";
import { renewalCopies } from "@/lib/vo-renewal-copies";

describe("renewalCopies", () => {
  it("copies only the owner on early reminders", () => {
    expect(renewalCopies({ reminderNumber: 1, ownerEmail: "Rep@TheWorkVilla.com" })).toEqual(["rep@theworkvilla.com"]);
    expect(renewalCopies({ reminderNumber: 3, ownerEmail: "rep@x.com" })).toEqual(["rep@x.com"]);
  });
  it("adds accounts from reminder 4 on, including the final notice", () => {
    expect(renewalCopies({ reminderNumber: 4, ownerEmail: "rep@x.com" })).toEqual(["rep@x.com", "accounts@theworkvilla.com"]);
    expect(renewalCopies({ reminderNumber: 5, ownerEmail: null })).toEqual(["accounts@theworkvilla.com"]);
  });
  it("ignores a missing or invalid owner email", () => {
    expect(renewalCopies({ reminderNumber: 2, ownerEmail: null })).toEqual([]);
    expect(renewalCopies({ reminderNumber: 2, ownerEmail: "not an email" })).toEqual([]);
    expect(renewalCopies({ reminderNumber: 2, ownerEmail: "" })).toEqual([]);
  });
  it("never repeats an address already on the message", () => {
    expect(renewalCopies({ reminderNumber: 4, ownerEmail: "rep@x.com", alreadyAddressed: ["REP@x.com", "accounts@theworkvilla.com"] })).toEqual([]);
  });
});
