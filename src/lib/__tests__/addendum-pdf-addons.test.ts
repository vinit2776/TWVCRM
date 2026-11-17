import { describe, it, expect } from "vitest";
import { generateAddendumPdf, type AddendumData } from "../addendum-generator";

const base: AddendumData = {
  renewal_contract_number: "TWV-C-0200",
  renewal_start_date: "2027-05-19",
  renewal_end_date: "2027-11-18",
  renewal_tenure_months: 6,
  renewal_subtotal: 36252,
  renewal_total_amount: 42777.36,
  renewal_tax_percentage: 18,
  renewal_tax_amount: 6525.36,
  renewal_escalation_percentage: 10,
  renewal_escalation_waived: false,
  renewal_seats: 4,
  renewal_billing_cycle: "monthly",
  renewal_sequence: 2,
  renewal_items: [{ description: "Private cabin", quantity: 4, unit_price: 9063, total: 36252 }],
  parent_contract_number: "TWV-C-0199",
  parent_start_date: "2026-11-19",
  parent_end_date: "2027-05-18",
  parent_subtotal: 32956,
  parent_seats: 4,
  parent_tenure_months: 6,
  client_name: "Acme Pvt Ltd",
  addendum_date: "2027-05-01",
};

const valet = { description: "Valet car parking", amount: 7000, effective_from: "2027-05-19", effective_until: "2027-11-18" };
const board = { description: "Name board", amount: 1500, effective_from: "2026-11-19", effective_until: "2027-05-18" };
const pdf = (d: AddendumData) => generateAddendumPdf(d).output();

// jsPDF wraps long clauses across lines, so only short tokens are matched in the raw stream;
// the exact wording is pinned in addendum-addons.test.ts.
describe("renewal addendum with recurring add-ons", () => {
  it("lists a continued add-on in its own clause and its own table section", () => {
    const out = pdf({ ...base, parent_addons: [{ ...valet, effective_from: "2026-11-19", effective_until: "2027-05-18" }], renewal_addons: [valet] });
    expect(out).toContain("Recurring Add-ons");
    expect(out).toContain("Valet");
    expect(out).toContain("43,252");
  });

  it("names an add-on that is not continued", () => {
    const out = pdf({ ...base, parent_addons: [board], renewal_addons: [] });
    expect(out).toContain("Name board");
    expect(out).toContain("Not continued");
  });

  it("is unchanged for a renewal with no add-ons on either side", () => {
    const out = pdf(base);
    expect(out).not.toContain("Recurring");
    expect(out).not.toContain("Valet");
    expect(out).toContain("36,252");
  });
});
