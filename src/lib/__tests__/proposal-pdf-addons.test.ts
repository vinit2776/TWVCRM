import { describe, it, expect } from "vitest";
import { generateProposalPDF } from "../pdf-generator";
import type { Proposal, ProposalAddon } from "@/types";

function pdfText(opts: { addons?: ProposalAddon[]; escalation?: number }): string {
  const items = [{ description: "Private cabin", quantity: 4, unit_price: 8239, total: 32956 }];
  const doc = generateProposalPDF(
    {
      id: "p1",
      proposal_number: "PROP-TEST",
      title: "Test",
      items,
      recurring_addons: opts.addons,
      escalation_percentage: opts.escalation,
      subtotal: 32956,
      tax_percentage: 18,
      tax_amount: 5932.08,
      discount_percentage: 0,
      discount_amount: 0,
      total_amount: 38888.08,
      status: "draft",
    } as unknown as Proposal,
    { first_name: "Test", last_name: "Lead" }
  );
  return doc.output();
}

describe("proposal PDF recurring add-ons", () => {
  it("lists add-ons apart from the fee lines and says they are not escalated", () => {
    const text = pdfText({ addons: [{ description: "Valet car parking", amount: 7000 }], escalation: 10 });
    // PDF string escaping turns "(" into "\(", so match the heading's start only.
    expect(text).toContain("Recurring Add-ons");
    expect(text).toContain("Valet car parking");
    expect(text).toContain("Recurring add-ons are not subject to escalation.");
    expect(text).toContain("Escalation of 10% applies to the monthly fee at each renewal.");
  });

  it("prints the negotiated escalation number, not a fixed 10", () => {
    const text = pdfText({ escalation: 7.5 });
    expect(text).toContain("Escalation of 7.5% applies to the monthly fee at each renewal.");
  });

  it("has no add-ons table when the proposal has none", () => {
    const text = pdfText({ addons: [], escalation: 10 });
    expect(text).not.toContain("Recurring Add-ons");
    expect(text).not.toContain("Recurring add-ons are not subject to escalation.");
  });

  it("prints no escalation sentence for a proposal saved before the figure existed", () => {
    const text = pdfText({});
    expect(text).not.toContain("Escalation of");
  });
});
