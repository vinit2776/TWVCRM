import { describe, expect, it } from "vitest";
import { suggestRequirement } from "../requirement-hint";

describe("suggestRequirement", () => {
  it("reads a cabin and a seat count from an enquiry message", () => {
    expect(suggestRequirement(["Hi, I'm Rahul from Acme. Need a cabin for 5 seats"])).toEqual({
      workspace_type: "private_office",
      seat_capacity: 5,
    });
  });

  it("reads a hot desk count", () => {
    expect(suggestRequirement(["Two hot desks from next month", "wants 2 seats"])).toEqual({
      workspace_type: "hot_desk",
      seat_capacity: 2,
    });
  });

  it("prefers the more specific type", () => {
    expect(suggestRequirement(["dedicated desks for 4 people"])?.workspace_type).toBe("dedicated_desk");
  });

  it("returns only what it can read", () => {
    expect(suggestRequirement(["Looking for a meeting room"])).toEqual({ workspace_type: "meeting_room", seat_capacity: null });
    expect(suggestRequirement(["6 seats please"])).toEqual({ workspace_type: null, seat_capacity: 6 });
  });

  it("never reads a phone number or year as seats", () => {
    expect(suggestRequirement(["call 9000000401 in 2026"])).toBeNull();
  });

  it("returns null for nothing useful", () => {
    expect(suggestRequirement(["hi", null, undefined, "  "])).toBeNull();
    expect(suggestRequirement([])).toBeNull();
  });
});
