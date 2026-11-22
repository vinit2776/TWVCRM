import { describe, it, expect } from "vitest";
import { PIN_QUIET_DAYS, pinLabel, pinState } from "../pin-age";

const NOW = new Date("2026-11-22T06:00:00Z");

describe("pinState", () => {
  it("is quiet at 14 days with no activity, not at 13", () => {
    expect(pinState("2026-11-08T06:00:00Z", null, NOW)).toEqual({ daysPinned: 14, daysQuiet: 14, quiet: true });
    expect(pinState("2026-11-09T06:00:00Z", null, NOW).quiet).toBe(false);
  });
  it("counts quiet from the last real activity when it is newer than the pin", () => {
    const s = pinState("2026-10-01T06:00:00Z", "2026-11-15T06:00:00Z", NOW);
    expect(s).toEqual({ daysPinned: 52, daysQuiet: 7, quiet: false });
  });
  it("ignores activity from before it was pinned", () => {
    expect(pinState("2026-11-01T06:00:00Z", "2026-10-01T06:00:00Z", NOW)).toMatchObject({ daysQuiet: 21, quiet: true });
  });
  it("a pin made today is not quiet", () => expect(pinState("2026-11-22T05:00:00Z", null, NOW)).toEqual({ daysPinned: 0, daysQuiet: 0, quiet: false }));
  it("uses the shared 14-day line", () => expect(PIN_QUIET_DAYS).toBe(14));
});

describe("pinLabel", () => {
  it("says how long, and flags a quiet pin", () => {
    expect(pinLabel({ daysPinned: 0, daysQuiet: 0, quiet: false }).text).toBe("Pinned today");
    expect(pinLabel({ daysPinned: 5, daysQuiet: 2, quiet: false }).text).toBe("Pinned 5 days");
    expect(pinLabel({ daysPinned: 1, daysQuiet: 1, quiet: false }).text).toBe("Pinned 1 day");
    expect(pinLabel({ daysPinned: 30, daysQuiet: 15, quiet: true })).toEqual({ text: "Pinned 30 days · no activity for 15 days", quiet: true });
  });
});
