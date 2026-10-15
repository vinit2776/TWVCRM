import { describe, it, expect } from "vitest";
import { usageSourceLabel } from "../usage-source-label";

describe("usageSourceLabel", () => {
  it("calls a booking-linked general charge a Booking, not Manual", () => {
    expect(usageSourceLabel("manual", true)).toBe("Booking");
    expect(usageSourceLabel("manual", true, "long")).toBe("Booking charge");
  });
  it("reserves 'Added by hand' for general charges with no booking", () => {
    expect(usageSourceLabel("manual", false)).toBe("Added by hand");
  });
  it("keeps print and facility labels", () => {
    expect(usageSourceLabel("print", false)).toBe("Print");
    expect(usageSourceLabel("print", false, "long")).toBe("Print log");
    expect(usageSourceLabel("facility", false)).toBe("Facility");
    expect(usageSourceLabel("facility", true, "long")).toBe("Facility usage");
  });
});
