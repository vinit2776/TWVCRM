import { describe, it, expect } from "vitest";
import { AMC_STEPS, validateAmcStep, contractLengthText, type AmcStepInput } from "../procurement/amc-wizard-steps";

const ok: AmcStepInput = {
  companyId: "c1", serviceName: "HVAC AMC", startDate: "2026-03-30", endDate: "2027-03-29",
  unlimitedVisits: false, visitsCovered: "4",
  lines: [{ assetId: "a1", perCycleCost: "10395", cycleCountOverride: "" }],
  contactName: "Ravi", helpline: "022-67154500",
};
const step = (key: string) => AMC_STEPS.findIndex((s) => s.key === key);

describe("validateAmcStep", () => {
  it("passes a complete request on every step", () => {
    for (let i = 0; i < AMC_STEPS.length; i++) expect(validateAmcStep(i, ok)).toBeNull();
  });
  it("needs a company first", () => {
    expect(validateAmcStep(step("who"), { ...ok, companyId: "" })).toMatch(/company/i);
  });
  it("needs a name, both dates, and a sensible end", () => {
    expect(validateAmcStep(step("contract"), { ...ok, serviceName: " " })).toMatch(/name/i);
    expect(validateAmcStep(step("contract"), { ...ok, endDate: "" })).toMatch(/starts and ends/i);
    expect(validateAmcStep(step("contract"), { ...ok, endDate: "2026-03-30" })).toMatch(/after the start/i);
  });
  it("needs visits unless unlimited", () => {
    expect(validateAmcStep(step("contract"), { ...ok, visitsCovered: "" })).toMatch(/visits/i);
    expect(validateAmcStep(step("contract"), { ...ok, visitsCovered: "", unlimitedVisits: true })).toBeNull();
  });
  it("needs an asset and a cost on every line, and no repeated asset", () => {
    expect(validateAmcStep(step("billing"), { ...ok, lines: [{ assetId: "", perCycleCost: "1", cycleCountOverride: "" }] })).toMatch(/asset/i);
    expect(validateAmcStep(step("billing"), { ...ok, lines: [{ assetId: "a1", perCycleCost: "", cycleCountOverride: "" }] })).toMatch(/before GST/i);
    expect(validateAmcStep(step("billing"), { ...ok, lines: [{ assetId: "a1", perCycleCost: "1", cycleCountOverride: "0" }] })).toMatch(/at least 1/i);
    expect(validateAmcStep(step("billing"), { ...ok, lines: [
      { assetId: "a1", perCycleCost: "1", cycleCountOverride: "" }, { assetId: "a1", perCycleCost: "1", cycleCountOverride: "" }] })).toMatch(/one line/i);
  });
  it("names the line number when there are several", () => {
    expect(validateAmcStep(step("billing"), { ...ok, lines: [
      { assetId: "a1", perCycleCost: "1", cycleCountOverride: "" }, { assetId: "", perCycleCost: "1", cycleCountOverride: "" }] })).toMatch(/line 2/);
  });
  it("needs a contact name and phone", () => {
    expect(validateAmcStep(step("contacts"), { ...ok, helpline: "" })).toMatch(/contact/i);
  });
  it("never blocks the proposal or review steps", () => {
    expect(validateAmcStep(step("proposal"), { ...ok, companyId: "" })).toBeNull();
    expect(validateAmcStep(step("review"), { ...ok, companyId: "" })).toBeNull();
  });
});

describe("contractLengthText", () => {
  it("calls a financial year 12 months", () => {
    expect(contractLengthText("2026-03-30", "2027-03-29")).toBe("12 months (1 year)");
  });
  it("handles other lengths", () => {
    expect(contractLengthText("2026-04-01", "2026-09-30")).toBe("6 months");
    expect(contractLengthText("2026-04-01", "2028-03-31")).toBe("24 months (2 years)");
  });
  it("is null for bad dates", () => {
    expect(contractLengthText("", "2027-03-29")).toBeNull();
  });
});
