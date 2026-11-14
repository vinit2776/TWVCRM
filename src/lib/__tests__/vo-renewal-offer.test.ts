import { describe, it, expect } from "vitest";
import { renewalOffer, escalationFor, termFee, RENEWAL_DURATIONS } from "@/lib/vo-renewal-offer";

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

describe("durations 11 and 48", () => {
  it("offers 11 and 48 months", () => {
    expect([...RENEWAL_DURATIONS]).toEqual([6, 11, 12, 24, 36, 48]);
  });
  it("scales pro rata for 11 months", () => {
    const o = renewalOffer({ ...BASE, durationMonths: 11, mode: "none" });
    expect(o.fee).toBe(16500);
    expect(o.term).toEqual({ start: "2026-12-19", end: "2027-11-18" });
  });
  it("scales pro rata for 48 months", () => {
    const o = renewalOffer({ ...BASE, durationMonths: 48, mode: "none" });
    expect(o.fee).toBe(72000);
    expect(o.term.end).toBe("2030-12-18");
  });
});

describe("termFee", () => {
  it("treats rate as the whole-term fee up to 12 months", () => {
    expect(termFee(18000, 6)).toBe(18000);
    expect(termFee(18000, 11)).toBe(18000);
    expect(termFee(18000, 12)).toBe(18000);
  });
  it("treats rate as the annual rate beyond 12 months", () => {
    expect(termFee(18000, 24)).toBe(36000);
    expect(termFee(18000, 36)).toBe(54000);
    expect(termFee(18000, 48)).toBe(72000);
  });
});
