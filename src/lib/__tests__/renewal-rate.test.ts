import { describe, it, expect } from "vitest";
import { renewalRate } from "@/lib/vo-renewal";

describe("renewalRate", () => {
  it("renews at the same rate when no escalation was agreed", () => {
    expect(renewalRate({ rate: 18000, renewal_escalation_percentage: 0 })).toBe(18000);
    expect(renewalRate({ rate: 18000, renewal_escalation_percentage: null })).toBe(18000);
    expect(renewalRate({ rate: 18000 })).toBe(18000);
  });

  it("applies the agreed escalation", () => {
    // The figure the agreement clause has always promised.
    expect(renewalRate({ rate: 18000, renewal_escalation_percentage: 5 })).toBe(18900);
    expect(renewalRate({ rate: 12000, renewal_escalation_percentage: 10 })).toBe(13200);
  });

  it("rounds to whole rupees", () => {
    // 2200 * 1.075 = 2365 exactly; 2201 * 1.075 = 2366.075 -> 2366.
    expect(renewalRate({ rate: 2200, renewal_escalation_percentage: 7.5 })).toBe(2365);
    expect(renewalRate({ rate: 2201, renewal_escalation_percentage: 7.5 })).toBe(2366);
    expect(Number.isInteger(renewalRate({ rate: 1333, renewal_escalation_percentage: 3.33 }))).toBe(true);
  });

  it("ignores a negative escalation rather than discounting the renewal", () => {
    expect(renewalRate({ rate: 18000, renewal_escalation_percentage: -5 })).toBe(18000);
  });
});
