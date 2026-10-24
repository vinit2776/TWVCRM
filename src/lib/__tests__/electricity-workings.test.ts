import { describe, it, expect } from "vitest";
import { electricityWorkings } from "@/lib/electricity-workings";

const lines = [
  { line_type: "utility" as const, units: 4930, amount: 4930 * 8 },
  { line_type: "generator" as const, units: 548, amount: 548 * 20 },
];

describe("electricityWorkings", () => {
  it("shows landlord units, the re-split, and rate + margin", () => {
    const t = electricityWorkings({ landlordLines: lines, type: "utility", customerPct: 80, customerUnits: 4382.4, customerRate: 9, showLandlordRate: true });
    expect(t).toContain("5,478 units");
    expect(t).toContain("80% = 4,382.4 units");
    expect(t).toMatch(/margin .*1/);
  });
  it("omits landlord rate and margin when hidden", () => {
    const t = electricityWorkings({ landlordLines: lines, type: "generator", customerPct: 20, customerUnits: 1095.6, customerRate: 22, showLandlordRate: false });
    expect(t).not.toMatch(/margin/i);
    expect(t).toContain("20% = 1,095.6 units");
  });
  it("returns undefined without landlord lines", () => {
    expect(electricityWorkings({ landlordLines: [], type: "utility", customerPct: 80, customerUnits: 1, customerRate: 1, showLandlordRate: true })).toBeUndefined();
  });
});
