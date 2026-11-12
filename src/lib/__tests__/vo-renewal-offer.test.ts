import { describe, it, expect } from "vitest";
import { renewalOffer, escalationFor } from "@/lib/vo-renewal-offer";

const BASE = {
  currentFee: 18000,
  currentTenureMonths: 12,
  agreedEscalationPercentage: 10,
  currentEnd: "2026-12-18",
  durationMonths: 12,
  mode: "agreed" as const,
};

describe("renewalOffer", () => {
  it("applies the agreed escalation to the full-term fee", () => {
    const o = renewalOffer(BASE);
    expect(o.term).toEqual({ start: "2026-12-19", end: "2027-12-18" });
    expect(o.baseFee).toBe(18000);
    expect(o.fee).toBe(19800);
    expect(o.gst).toBe(3564);
    expect(o.total).toBe(23364);
  });

  it("prices a different length pro rata from the current term", () => {
    expect(renewalOffer({ ...BASE, durationMonths: 6, mode: "none" }).fee).toBe(9000);
    const three = renewalOffer({ ...BASE, durationMonths: 36 });
    expect(three.baseFee).toBe(54000);
    expect(three.fee).toBe(59400);
    expect(three.term.end).toBe("2029-12-18");
  });

  it("uses the custom percentage only in custom mode", () => {
    expect(renewalOffer({ ...BASE, mode: "custom", customPercentage: 5 }).fee).toBe(18900);
    expect(renewalOffer({ ...BASE, mode: "none", customPercentage: 5 }).fee).toBe(18000);
  });

  it("treats a missing tenure as 12 months", () => {
    expect(renewalOffer({ ...BASE, currentTenureMonths: null, mode: "none" }).fee).toBe(18000);
  });
});

describe("escalationFor", () => {
  it("never escalates below zero", () => {
    expect(escalationFor("agreed", null, null)).toBe(0);
    expect(escalationFor("custom", 10, -3)).toBe(0);
  });
});
