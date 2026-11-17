import { describe, it, expect } from "vitest";
import { planAmcPrefill, suggestAssetForUnit, UNIT_SKIPPED, type PrefillCurrent } from "../procurement/amc-prefill";
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
  contactName: null, contactPhone: null, contactEmail: null, contactCandidates: [],
  equipment: [{ description: "DPA1321 package unit", model: "DPA1321R3-IA", serial: "S1", capacity: "11 TR", rate: 22770 }],
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
    expect(p.questions[0].options.map((o) => o.value).sort()).toEqual(["22770", "33000"]);
    expect(p.updates.firstLine).toBeUndefined();
  });
  it("applies the user's answer to the question", () => {
    const p = planAmcPrefill({ ...blueStar, amountCandidates: [22770, 33000] }, empty, { amount: "33000" });
    expect(p.questions).toEqual([]);
    expect(p.updates.firstLine).toEqual({ billingCycle: "half_yearly", perCycleCost: "16500", proposalTotal: 33000 });
  });
  it("leaves the cost blank when the total does not split evenly", () => {
    const p = planAmcPrefill({ ...blueStar, valueBeforeGst: 22770.01 }, empty);
    expect(p.updates.firstLine).toEqual({ billingCycle: "half_yearly", proposalTotal: 22770.01 });
    expect(p.notes.join(" ")).toMatch(/does not split evenly/);
  });
  it("counts a multi-year contract's visits for every year", () => {
    const p = planAmcPrefill({ ...blueStar, endDate: "2028-03-29" }, empty);
    expect(p.updates.visitsCovered).toBe("8");
  });
  it("asks how the vendor bills when the proposal does not say, and uses the answer", () => {
    const asked = planAmcPrefill({ ...blueStar, billingFrequency: null }, empty);
    expect(asked.updates.firstLine).toBeUndefined();
    expect(asked.questions.map((q) => q.id)).toEqual(["frequency"]);
    const answered = planAmcPrefill({ ...blueStar, billingFrequency: null }, empty, { frequency: "quarterly" });
    expect(answered.questions).toEqual([]);
    expect(answered.updates.firstLine).toEqual({ billingCycle: "quarterly", perCycleCost: "5692.5", proposalTotal: 22770 });
  });
  it("asks who pays for parts when coverage is unclear, and never assumes", () => {
    const asked = planAmcPrefill({ ...blueStar, coverage: null }, empty);
    expect(asked.questions.map((q) => q.id)).toEqual(["coverage"]);
    expect(asked.updates.coverage).toBeUndefined();
    const answered = planAmcPrefill({ ...blueStar, coverage: null }, empty, { coverage: "labour_only" });
    expect(answered.questions).toEqual([]);
    expect(answered.updates.coverage).toBe("labour_only");
  });
  it("ignores an end date that is not after the start", () => {
    const p = planAmcPrefill({ ...blueStar, endDate: "2026-03-01" }, empty);
    expect(p.updates.startDate).toBeUndefined();
  });
});

describe("vendor contact", () => {
  const two = { ...blueStar, contactName: "Yuva Kumar", contactPhone: "7401777684", contactEmail: null,
    contactCandidates: [{ name: "Michael Angre", phone: "022-67154500", email: "cs@bluestarindia.com", role: "Service Manager" }] };
  it("asks who to call when the proposal gives more than one contact", () => {
    const p = planAmcPrefill(two, empty);
    expect(p.questions.map((q) => q.id)).toEqual(["contact"]);
    expect(p.questions[0].options.map((o) => o.label)).toEqual(["Yuva Kumar · 7401777684", "Michael Angre · 022-67154500 · Service Manager"]);
    expect(p.updates.contactName).toBeUndefined();
  });
  it("uses the contact the user chose", () => {
    const p = planAmcPrefill(two, empty, { contact: "1" });
    expect(p.questions).toEqual([]);
    expect(p.updates).toMatchObject({ contactName: "Michael Angre", helpline: "022-67154500", contactEmail: "cs@bluestarindia.com" });
  });
  it("counts the same person listed twice once and does not ask", () => {
    const p = planAmcPrefill({ ...two, contactCandidates: [{ name: "Yuva K", phone: "+91 74017 77684", email: null, role: null }] }, empty);
    expect(p.questions).toEqual([]);
    expect(p.updates).toMatchObject({ contactName: "Yuva Kumar", helpline: "7401777684" });
  });
  it("uses a single contact as read and notes when there is none", () => {
    expect(planAmcPrefill({ ...blueStar, contactName: "A B", contactPhone: "9876543210" }, empty).updates.contactName).toBe("A B");
    expect(planAmcPrefill(blueStar, empty).notes.join(" ")).toMatch(/No vendor contact/);
  });
});

// Shaped like the Blue Star proposal Q-780826: five units, each with its own cost, billed half-yearly.
const fiveUnits: ExtractedAmcProposal = {
  ...blueStar,
  proposalNumber: "Q-780826", valueBeforeGst: 64170,
  equipment: [
    { description: "Package IDU", model: "DPA1321R3-IA", serial: "HVF00117", capacity: "11.00 TR", rate: 22770 },
    { description: "Ducted ODU", model: "DSA361R1-OA", serial: "FSF02371", capacity: "3.00 TR", rate: 6210 },
    { description: "Ducted ODU", model: "DSA361R1-OA", serial: "LUF05380", capacity: "3.00 TR", rate: 6210 },
    { description: "Ducted ODU", model: "DSA361R1-OA", serial: "HSF03069", capacity: "3.00 TR", rate: 6210 },
    { description: "Package IDU", model: "DPA1321R3-IA", serial: "BXF00075", capacity: "11.00 TR", rate: 22770 },
  ],
};

describe("planAmcPrefill with several units", () => {
  it("waits for every unit to be matched to an asset before filling any line", () => {
    const p = planAmcPrefill(fiveUnits, empty, {}, ["a1", "a2", "", "", ""]);
    expect(p.unitsToDecide).toBe(3);
    expect(p.updates.lines).toBeUndefined();
  });
  it("makes one line per asset with that asset's share of each bill", () => {
    const p = planAmcPrefill(fiveUnits, empty, {}, ["a1", "a2", "a3", "a4", "a5"]);
    expect(p.unitsToDecide).toBe(0);
    expect(p.updates.lines).toEqual([
      { assetId: "a1", billingCycle: "half_yearly", perCycleCost: "11385", proposalTotal: 22770 },
      { assetId: "a2", billingCycle: "half_yearly", perCycleCost: "3105", proposalTotal: 6210 },
      { assetId: "a3", billingCycle: "half_yearly", perCycleCost: "3105", proposalTotal: 6210 },
      { assetId: "a4", billingCycle: "half_yearly", perCycleCost: "3105", proposalTotal: 6210 },
      { assetId: "a5", billingCycle: "half_yearly", perCycleCost: "11385", proposalTotal: 22770 },
    ]);
  });
  it("bills together the units the user matches to one asset", () => {
    const p = planAmcPrefill(fiveUnits, empty, {}, ["pkg", "duct", "duct", "duct", "pkg"]);
    expect(p.updates.lines).toEqual([
      { assetId: "pkg", billingCycle: "half_yearly", perCycleCost: "22770", proposalTotal: 45540 },
      { assetId: "duct", billingCycle: "half_yearly", perCycleCost: "9315", proposalTotal: 18630 },
    ]);
  });
  it("leaves out a unit that is not ours and warns that the total no longer matches", () => {
    const p = planAmcPrefill(fiveUnits, empty, {}, ["a1", "a2", "a3", UNIT_SKIPPED, "a5"]);
    expect(p.updates.lines).toHaveLength(4);
    expect(p.notes.join(" ")).toMatch(/1 unit was left out/);
    expect(p.notes.join(" ")).toMatch(/add up to ₹57,960, but the proposal total is ₹64,170/);
    expect(p.unitScope).toEqual({ covered: 4, leftOut: 1, coveredTotal: 57960, proposalTotal: 64170 });
  });
  it("asks how the vendor bills before splitting unit costs", () => {
    const p = planAmcPrefill({ ...fiveUnits, billingFrequency: null }, empty, {}, ["a1", "a2", "a3", "a4", "a5"]);
    expect(p.questions.map((q) => q.id)).toEqual(["frequency"]);
    expect(p.updates.lines).toBeUndefined();
  });
  it("leaves an asset's cost blank when its units do not split into whole bills", () => {
    const odd = { ...fiveUnits, equipment: fiveUnits.equipment.map((e, i) => (i === 1 ? { ...e, rate: 6210.01 } : e)) };
    const p = planAmcPrefill(odd, empty, {}, ["a1", "a2", "a3", "a4", "a5"]);
    expect(p.updates.lines?.find((l) => l.assetId === "a2")?.perCycleCost).toBe("");
    expect(p.notes.join(" ")).toMatch(/does not split evenly/);
  });
  it("does not replace asset lines the user already entered", () => {
    const typed: PrefillCurrent = { ...empty, firstLine: { assetId: "x", perCycleCost: "", lineCount: 1 } };
    const p = planAmcPrefill(fiveUnits, typed, {}, ["a1", "a2", "a3", "a4", "a5"]);
    expect(p.updates.lines).toBeUndefined();
    expect(p.notes.join(" ")).toMatch(/already entered asset lines/);
  });
});

describe("suggestAssetForUnit", () => {
  const assets = [{ id: "a", serial_number: " hvf00117 " }, { id: "b", serial_number: "FSF02371" }, { id: "c", serial_number: "dup" }, { id: "d", serial_number: "DUP" }];
  it("matches on serial number, ignoring case and spaces", () => {
    expect(suggestAssetForUnit({ serial: "HVF00117" }, assets)).toBe("a");
  });
  it("does not guess when no asset or several assets share the serial", () => {
    expect(suggestAssetForUnit({ serial: "NOPE" }, assets)).toBe("");
    expect(suggestAssetForUnit({ serial: "dup" }, assets)).toBe("");
    expect(suggestAssetForUnit({ serial: null }, assets)).toBe("");
  });
});

describe("normaliseProposal", () => {
  it("accepts a well-formed reading and trims it", () => {
    const x = normaliseProposal({ vendor_name: " Blue Star ", start_date: "2026-03-30", end_date: "2027-03-29", billing_frequency: "half_yearly", visits_per_year: 4, value_before_gst: 22770, equipment: [{ description: "Unit", model: "M1", serial: "SN1", capacity: "11 TR", rate: 22770 }], confidence: "high" });
    expect(x).toMatchObject({ vendorName: "Blue Star", billingFrequency: "half_yearly", visitsPerYear: 4, valueBeforeGst: 22770 });
    expect(x?.equipment[0]).toMatchObject({ model: "M1", serial: "SN1" });
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

describe("proposal ceilings", () => {
  it("caps a one-unit proposal at its contract value, even when the cost per bill is left blank", () => {
    expect(planAmcPrefill(blueStar, empty).updates.firstLine?.proposalTotal).toBe(22770);
    expect(planAmcPrefill({ ...blueStar, valueBeforeGst: 22770.01 }, empty).updates.firstLine?.proposalTotal).toBe(22770.01);
  });
  it("caps each asset line at the sum of its units' costs", () => {
    const p = planAmcPrefill(fiveUnits, empty, {}, ["pkg", "duct", "duct", "duct", "pkg"]);
    expect(p.updates.lines?.map((l) => l.proposalTotal)).toEqual([45540, 18630]);
  });
  it("sets no ceiling on a line whose unit has no cost in the proposal", () => {
    const noRate = { ...fiveUnits, equipment: fiveUnits.equipment.map((e, i) => (i === 1 ? { ...e, rate: null } : e)) };
    const p = planAmcPrefill(noRate, empty, {}, ["a1", "a2", "a3", "a4", "a5"]);
    expect(p.updates.lines?.[1].proposalTotal).toBeUndefined();
    expect(p.updates.lines?.[0].proposalTotal).toBe(22770);
  });
});
