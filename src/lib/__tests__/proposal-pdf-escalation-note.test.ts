import { describe, it, expect } from "vitest";
import { generateProposalPDF } from "../pdf-generator";
import type { Proposal } from "@/types";

const NOTE = "Annual escalation applies to rent only";

function pdfText(items: Proposal["items"]): string {
  const total = items.reduce((s, i) => s + i.total, 0);
  const doc = generateProposalPDF(
    {
      id: "p1",
      proposal_number: "PROP-TEST",
      title: "Test",
      items,
      subtotal: total,
      tax_percentage: 18,
      tax_amount: total * 0.18,
      discount_percentage: 0,
      discount_amount: 0,
      total_amount: total * 1.18,
      status: "draft",
    } as unknown as Proposal,
    { first_name: "Test", last_name: "Lead" }
  );
  return doc.output();
}

describe("proposal PDF escalation note", () => {
  it("states that escalation applies to rent only when a line is fixed", () => {
    const text = pdfText([
      { description: "Rent", quantity: 1, unit_price: 205440, total: 205440, escalates: true },
      { description: "Maintenance", quantity: 1, unit_price: 28800, total: 28800, escalates: false },
    ]);
    expect(text).toContain(NOTE);
  });

  it("adds nothing for an ordinary single-line proposal", () => {
    const text = pdfText([{ description: "Desk", quantity: 1, unit_price: 8000, total: 8000 }]);
    expect(text).not.toContain(NOTE);
  });
});
