import { describe, it, expect } from "vitest";
import { generateMembershipAgreementPDF } from "@/lib/pdf-generator";
import type { Contract, ContractAddon } from "@/types";

const base = {
  id: "c1", contract_number: "TWV-C-9999", title: "Test", status: "draft", items: [],
  start_date: "2026-11-19", end_date: "2027-05-18", agreement_date: "2026-11-16",
  tenure_months: 6, subtotal: 36252, total_amount: 42777, security_deposit_months: 2,
  notice_period_months: 2, lock_in_months: 4, escalation_percentage: 10,
  member_signatory_name: "A Person", member_signatory_designation: "Director",
} as unknown as Contract;

const valet = {
  id: "a1", contract_id: "c1", description: "Valet car parking", amount: 7000,
  effective_from: "2026-11-19", effective_until: "2027-05-18", is_active: true,
} as unknown as ContractAddon;

const pdf = (c: Contract) =>
  generateMembershipAgreementPDF(c, { company: "Acme Pvt Ltd" }, { name: "Test Location" }, { watermarkDraft: true }).output();

// jsPDF wraps long clauses across lines, so only short tokens are matched in the raw
// stream here; the exact clause wording is pinned in agreement-addons.test.ts.
describe("membership agreement with recurring add-ons", () => {
  it("lists the add-on in its own row", () => {
    const out = pdf({ ...base, recurring_addons: [valet] });
    expect(out).toContain("Recurring");
    expect(out).toContain("Valet");
    expect(out).toContain("escalation");
  });

  it("keeps the fee in item 8 as the escalating monthly fee only", () => {
    const out = pdf({ ...base, recurring_addons: [valet] });
    expect(out).toContain("36,252");
  });

  it("prints a negotiated half percent properly", () => {
    const out = pdf({ ...base, escalation_percentage: 12.5, recurring_addons: [valet] });
    expect(out).toContain("12.5");
    expect(out).not.toContain("12.5.0");
  });

  it("adds nothing for an agreement with no add-ons", () => {
    const out = pdf(base);
    expect(out).not.toContain("Recurring");
    expect(out).not.toContain("Valet");
  });

  it("does not list a paused add-on", () => {
    const out = pdf({ ...base, recurring_addons: [{ ...valet, is_active: false }] });
    expect(out).not.toContain("Valet");
    expect(out).not.toContain("Recurring");
  });
});
