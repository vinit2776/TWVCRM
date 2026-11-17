import { describe, it, expect } from "vitest";
import { generateMembershipAgreementPDF } from "@/lib/pdf-generator";
import type { Contract } from "@/types";
import { standardAgreementTerms } from "@/lib/agreement-terms";

const base = {
  id: "c1", contract_number: "TWV-C-9999", title: "Test", status: "draft", items: [],
  start_date: "2026-11-01", end_date: "2027-10-31", agreement_date: "2026-10-21",
  tenure_months: 12, subtotal: 85000, total_amount: 100300, security_deposit_months: 3,
  notice_period_months: 2, lock_in_months: 6, member_signatory_name: "A Person", member_signatory_designation: "Director",
} as unknown as Contract;

const text = (c: Contract) => generateMembershipAgreementPDF(c, { company: "Acme Pvt Ltd" }, { name: "Test Location" }, { watermarkDraft: true }).output();

describe("membership agreement special clause", () => {
  const clause = "37. Special Conditions. The Member shall be entitled to use the Cabin 4 meeting room for ten (10) hours each month.";

  it("prints an approved clause as clause 37 without repeating the heading", () => {
    const out = text({ ...base, special_clause_status: "approved", special_clause_text: clause });
    expect(out).toContain("Special");
    expect(out).toContain("Cabin 4");
    expect(out).not.toContain("37. Special Conditions. The Member");
  });

  it("never prints a clause that isn't approved", () => {
    for (const status of ["pending_approval", "changes_requested"] as const) {
      expect(text({ ...base, special_clause_status: status, special_clause_text: clause })).not.toContain("Cabin 4");
    }
    expect(text(base)).not.toContain("Cabin 4");
  });
});

describe("agreement Schedule by location", () => {
  const withLocation = (location: Record<string, unknown>) =>
    generateMembershipAgreementPDF(base, { company: "Acme Pvt Ltd" }, location, { watermarkDraft: true }).output();
  const pantryOff = {
    name: "Perungudi",
    proposal_amenity_icons: ["wifi", "printer", "meeting"],
    agreement_terms: standardAgreementTerms(),
  };

  it("prints the standard wording for a location with no saved terms", () => {
    const out = withLocation({ name: "Anywhere" });
    expect(out).toContain("Hot tea");
    expect(out).toContain("Coffee/Tea twice");
    expect(out).toContain("Cafe / Vending");
  });

  it("drops every tea/coffee line when Pantry Services is not offered", () => {
    const out = withLocation(pantryOff);
    expect(out).not.toContain("Hot tea");
    expect(out).not.toContain("Coffee/Tea");
    expect(out).not.toContain("Vending");
    expect(out).toContain("Conference Room @ INR 1000");
  });

  it("prints edited wording exactly as typed", () => {
    const terms = standardAgreementTerms();
    terms.facilities.coffee.inclusions = ["Tea and coffee, 8 cups per week, per seat"];
    const out = withLocation({ name: "X", proposal_amenity_icons: ["coffee"], agreement_terms: terms });
    expect(out).toContain("8 cups per week");
    expect(out).not.toContain("12 cups");
  });
});
