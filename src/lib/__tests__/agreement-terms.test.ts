import { describe, it, expect } from "vitest";
import {
  agreementTermsSchema, buildScheduleLines, canEditAgreementTerms, cleanAgreementTerms, formatScheduleRow, readAgreementTerms, standardAgreementTerms,
} from "@/lib/agreement-terms";

describe("buildScheduleLines", () => {
  it("returns the long-standing wording when a location has no terms", () => {
    const lines = buildScheduleLines(null, undefined);
    expect(lines.inclusions).toHaveLength(4);
    expect(lines.paid).toHaveLength(5);
    expect(lines.rates).toHaveLength(4);
  });

  it("hands back copies so callers can't corrupt the standard wording", () => {
    buildScheduleLines(null, undefined).inclusions.push("x");
    expect(buildScheduleLines(null, undefined).inclusions).toHaveLength(4);
  });

  it("prints only ticked facilities, general lines always", () => {
    const lines = buildScheduleLines(standardAgreementTerms(), ["wifi"]);
    expect(lines.inclusions).toEqual([
      "Electricity & air conditioning consumed during office hours.",
      "Housekeeping, security and maintenance services",
      "Wi-Fi and Internet as per fair usage Policy",
    ]);
    expect(lines.rates).toEqual([]);
    expect(lines.paid.at(-1)).toContain("Rs.2500");
  });

  it("treats a location with no amenity choice as the default four", () => {
    const lines = buildScheduleLines(standardAgreementTerms(), null);
    expect(lines.rates.join(" ")).toContain("Coffee/Tea");
    expect(lines.rates.join(" ")).not.toContain("Parking");
  });
});

describe("formatScheduleRow", () => {
  it("bullets each line and says Nil when empty", () => {
    expect(formatScheduleRow(["a", "b"])).toBe("• a\n• b");
    expect(formatScheduleRow([])).toBe("Nil");
  });
});

describe("agreement terms validation", () => {
  it("rejects unknown facilities and over-long lines", () => {
    const t = standardAgreementTerms();
    expect(agreementTermsSchema.safeParse({ ...t, facilities: { ...t.facilities, sauna: t.general } }).success).toBe(false);
    expect(agreementTermsSchema.safeParse({ ...t, general: { ...t.general, paid: ["x".repeat(301)] } }).success).toBe(false);
  });

  it("trims and drops blank lines", () => {
    const t = standardAgreementTerms();
    t.general.inclusions = ["  keep  ", "   ", ""];
    expect(cleanAgreementTerms(t).general.inclusions).toEqual(["keep"]);
  });

  it("reads malformed stored data as 'use the standard wording'", () => {
    expect(readAgreementTerms({ nope: true })).toBeNull();
    expect(readAgreementTerms(null)).toBeNull();
  });
});

describe("canEditAgreementTerms", () => {
  it("allows admin, manager and sales rep only", () => {
    for (const r of ["admin", "manager", "sales_rep"]) expect(canEditAgreementTerms(r)).toBe(true);
    for (const r of ["accounts", "it_manager", "coordinator", "fms", "", null, undefined]) expect(canEditAgreementTerms(r)).toBe(false);
  });
});
