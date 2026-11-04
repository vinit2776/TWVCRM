import { describe, it, expect } from "vitest";
import { assessValue, formatValue, requestThemes, seatBand } from "../lead-value";

const NOW = new Date("2026-11-04T05:00:00Z");

describe("assessValue", () => {
  it("is high value at ₹50,000 a month, using the price they gave", () => {
    const r = assessValue({ seats: 8, workspaceType: "private_office", budgetPerSeat: 12000, now: NOW });
    expect(r).toMatchObject({ monthly: 96000, estimated: false, tier: "high" });
  });

  it("prefers a quote over their budget", () => {
    expect(assessValue({ seats: 4, quotedPerSeat: 10000, budgetPerSeat: 6000, now: NOW }).monthly).toBe(40000);
  });

  it("falls back to the rate card and says it is an estimate", () => {
    const r = assessValue({ seats: 4, workspaceType: "dedicated_desk", standardRate: 9000, now: NOW });
    expect(r).toMatchObject({ monthly: 36000, estimated: true, tier: "worth_a_call" });
  });

  it("is high value from 10 seats whatever the price", () => {
    expect(assessValue({ seats: 10, workspaceType: "hot_desk", budgetPerSeat: 1000, now: NOW }).tier).toBe("high");
  });

  it("is high value for an office with a company starting within 8 weeks", () => {
    const r = assessValue({ seats: 3, workspaceType: "private_office", budgetPerSeat: 5000, hasCompany: true, startDate: "2026-12-01", now: NOW });
    expect(r.tier).toBe("high");
    expect(assessValue({ seats: 3, workspaceType: "private_office", budgetPerSeat: 4000, hasCompany: true, startDate: "2027-03-01", now: NOW }).tier).toBe("passing");
  });

  it("is passing for one or two virtual or hot desks, even with a price", () => {
    expect(assessValue({ seats: 2, workspaceType: "virtual_office", budgetPerSeat: 9000, now: NOW }).tier).toBe("passing");
    expect(assessValue({ seats: 1, workspaceType: "hot_desk", budgetPerSeat: 9000, now: NOW }).tier).toBe("passing");
  });

  it("is passing under ₹15,000 and when value is unknown", () => {
    expect(assessValue({ seats: 2, workspaceType: "dedicated_desk", budgetPerSeat: 6000, now: NOW }).tier).toBe("passing");
    const unknown = assessValue({ seats: 3, workspaceType: "dedicated_desk", now: NOW });
    expect(unknown).toMatchObject({ monthly: null, tier: "passing" });
    expect(unknown.reasons[0]).toMatch(/no price/);
    expect(assessValue({ now: NOW }).reasons[0]).toMatch(/no seats/);
  });

  it("is worth a call between ₹15,000 and ₹50,000", () => {
    expect(assessValue({ seats: 3, workspaceType: "dedicated_desk", budgetPerSeat: 8000, now: NOW }).tier).toBe("worth_a_call");
  });
});

describe("formatValue", () => {
  it("uses lakh and crore", () => {
    expect(formatValue(96000)).toBe("₹96,000");
    expect(formatValue(310000)).toBe("₹3.1 L");
    expect(formatValue(14200000)).toBe("₹1.4 Cr");
  });
});

describe("requestThemes", () => {
  it("groups free text into fixed themes", () => {
    expect(requestThemes("Need 2 parking slots and want a site visit this week")).toEqual(["tour", "parking", "soon"]);
    expect(requestThemes("24x7 access and GST invoice please")).toEqual(["access", "gst"]);
  });
  it("does not match inside other words", () => {
    expect(requestThemes("Spark park avenue")).toEqual(["parking"]);
    expect(requestThemes("a tournament")).toEqual([]);
    expect(requestThemes(null)).toEqual([]);
  });
});

describe("seatBand", () => {
  it("bands seats", () => {
    expect([1, 2, 3, 5, 6, 9, 10, 40].map(seatBand)).toEqual(["1-2", "1-2", "3-5", "3-5", "6-9", "6-9", "10+", "10+"]);
    expect(seatBand(0)).toBeNull();
  });
});
