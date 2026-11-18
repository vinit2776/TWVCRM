import { describe, it, expect } from "vitest";
import { isPrepaidApplicableToSpace, isPrepaidOwnedByCustomer, escapeLike } from "../prepaid";

describe("isPrepaidApplicableToSpace", () => {
  const meeting = { id: "s1", workspace_type: "meeting_room" };

  it("accepts a package for the matching space type", () => {
    expect(isPrepaidApplicableToSpace({ workspace_type: "meeting_room" }, meeting)).toBe(true);
  });
  it("rejects a package for a different space type", () => {
    expect(isPrepaidApplicableToSpace({ workspace_type: "day_pass" }, meeting)).toBe(false);
  });
  it("rejects a package bound to another space", () => {
    expect(isPrepaidApplicableToSpace({ space_id: "s2" }, meeting)).toBe(false);
  });
  it("accepts a package bound to this space", () => {
    expect(isPrepaidApplicableToSpace({ space_id: "s1", workspace_type: "meeting_room" }, meeting)).toBe(true);
  });
  it("treats a legacy unrestricted package as applicable", () => {
    expect(isPrepaidApplicableToSpace({}, meeting)).toBe(true);
  });
});

describe("isPrepaidOwnedByCustomer", () => {
  it("matches the lead that bought the package", () => {
    expect(isPrepaidOwnedByCustomer({ lead_id: "l1" }, { leadId: "l1" })).toBe(true);
  });
  it("does not let another lead use a personal package", () => {
    expect(isPrepaidOwnedByCustomer({ lead_id: "l1" }, { leadId: "l2", company: "Zenith Labs" })).toBe(false);
  });
  it("lets any contact of the company use a company package, ignoring case and spacing", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9", company: "  zenith labs " })).toBe(true);
  });
  it("rejects a different company", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9", company: "Other Co" })).toBe(false);
  });
  it("rejects when the customer has no company", () => {
    expect(isPrepaidOwnedByCustomer({ company_name: "Zenith Labs" }, { leadId: "l9" })).toBe(false);
  });
});

describe("escapeLike", () => {
  it("escapes wildcards so names match literally", () => {
    expect(escapeLike("50%_off\\co")).toBe("50\\%\\_off\\\\co");
  });
});
