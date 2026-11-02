import { describe, it, expect } from "vitest";
import { planAmcPrefill, type PrefillCurrent } from "../procurement/amc-prefill";
import { normaliseProposal, type ExtractedAmcProposal } from "../procurement/proposal-extraction";

const empty: PrefillCurrent = {
  serviceName: "", startDate: "", endDate: "", visitsCovered: "", unlimitedVisits: false,
  contactName: "", helpline: "", contactEmail: "",
  firstLine: { assetId: "", perCycleCost: "", lineCount: 1 },
};

// Shaped like the Blue Star proposal for an 11 TR package unit.
const blueStar: ExtractedAmcProposal = {
  vendorName: "Blue Star Limited", proposalNumber: "1005823270",
  startDate: "2026-03-30", endDate: "2027-03-29",
  billingFrequency: "half_yearly", billedInAdvance: true, visitsPerYear: 4, coverage: "comprehensive",
  valueBeforeGst: 22770, amountCandidates: [], gstPercent: 18,
  contactName: null, contactPhone: null, contactEmail: null,
  equipment: [{ description: "DPA1321 package unit", capacity: "11 TR", rate: 22770 }],
  confidence: "high",
};

describe("planAmcPrefill", () => {
  it("fills the contract, visits, coverage and per-bill cost from a clear proposal", () => {
    const p = planAmcPrefill(blueStar, empty);
    expect(p.updates).toMatchObject({
      serviceName: "AMC, Blue Star Limited",
      startDate: "2026-03-30", endDate: "2027-03-29",
      visitsCovered: "4", coverage: "comprehensive",
      firstLine: { billingCycle: "half_yearly", perCycleCost: "11385" },
    });
    expect(p.questions).toEqual([]);
    expect(p.notes.join(" ")).toMatch(/18% GST/);
  });
  it("never overwrites what the user already typed", () => {
    const typed: PrefillCurrent = { ...empty, serviceName: "Mine", startDate: "2026-04-01", endDate: "2027-03-31", visitsCovered: "12", firstLine: { assetId: "a", perCycleCost: "500", lineCount: 1 } };
    const p = planAmcPrefill(blueStar, typed);
    expect(p.updates.serviceName).toBeUndefined();
    expect(p.updates.startDate).toBeUndefined();
    expect(p.updates.visitsCovered).toBeUndefined();
    expect(p.updates.firstLine).toBeUndefined();
  });
  it("asks instead of choosing when two amounts could be the total", () => {
    const p = planAmcPrefill({ ...blueStar, amountCandidates: [22770, 33000] }, empty);
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0].options.map((o) => o.value).sort()).toEqual([22770, 33000]);
    expect(p.updates.firstLine).toBeUndefined();
  });
  it("applies the user's answer to the question", () => {
    const p = planAmcPrefill({ ...blueStar, amountCandidates: [22770, 33000] }, empty, 33000);
    expect(p.questions).toEqual([]);
    expect(p.updates.firstLine).toEqual({ billingCycle: "half_yearly", perCycleCost: "16500" });
  });
  it("does not put a multi-unit total on one asset line", () => {
    const p = planAmcPrefill({ ...blueStar, equipment: [{ description: "A", capacity: "5.5 TR", rate: 11385 }, { description: "B", capacity: "3 TR", rate: 6210 }] }, empty);
    expect(p.updates.firstLine).toBeUndefined();
    expect(p.notes.join(" ")).toMatch(/2 units/);
  });
  it("leaves the cost blank when the total does not split evenly", () => {
    const p = planAmcPrefill({ ...blueStar, valueBeforeGst: 22770.01 }, empty);
    expect(p.updates.firstLine).toBeUndefined();
    expect(p.notes.join(" ")).toMatch(/does not split evenly/);
  });
  it("counts a multi-year contract's visits for every year", () => {
    const p = planAmcPrefill({ ...blueStar, endDate: "2028-03-29" }, empty);
    expect(p.updates.visitsCovered).toBe("8");
  });
  it("asks the user to choose billing when the proposal does not say", () => {
    const p = planAmcPrefill({ ...blueStar, billingFrequency: null }, empty);
    expect(p.updates.firstLine).toBeUndefined();
    expect(p.notes.join(" ")).toMatch(/billing frequency/i);
  });
  it("ignores an end date that is not after the start", () => {
    const p = planAmcPrefill({ ...blueStar, endDate: "2026-03-01" }, empty);
    expect(p.updates.startDate).toBeUndefined();
  });
});

describe("normaliseProposal", () => {
  it("accepts a well-formed reading and trims it", () => {
    const x = normaliseProposal({ vendor_name: " Blue Star ", start_date: "2026-03-30", end_date: "2027-03-29", billing_frequency: "half_yearly", visits_per_year: 4, value_before_gst: 22770, equipment: [{ description: "Unit", capacity: "11 TR", rate: 22770 }], confidence: "high" });
    expect(x).toMatchObject({ vendorName: "Blue Star", billingFrequency: "half_yearly", visitsPerYear: 4, valueBeforeGst: 22770 });
  });
  it("drops values that fail the checks instead of failing the whole reading", () => {
    const x = normaliseProposal({ vendor_name: "V", visits_per_year: -3, value_before_gst: -5, billing_frequency: "weekly", contact_email: "not an email", start_date: "30/03/2026" });
    expect(x).toMatchObject({ visitsPerYear: null, valueBeforeGst: null, billingFrequency: null, contactEmail: null, startDate: null });
  });
  it("returns null when nothing could be read", () => {
    expect(normaliseProposal({})).toBeNull();
    expect(normaliseProposal("nope")).toBeNull();
  });
  it("keeps distinct positive amount candidates only", () => {
    const x = normaliseProposal({ vendor_name: "V", amount_candidates: [100, 100, 0, -1, 200] });
    expect(x?.amountCandidates).toEqual([100, 200]);
  });
});
