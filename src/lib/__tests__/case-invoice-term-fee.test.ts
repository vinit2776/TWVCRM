import { describe, expect, it } from "vitest";
import { computeCaseInvoice } from "@/lib/case-invoicing";

type CaseForInvoicing = Parameters<typeof computeCaseInvoice>[0];

const base = (o: Partial<CaseForInvoicing>): CaseForInvoicing =>
  ({ id: "c1", rate: 18000, tenure_months: 12, start_date: "2026-01-01", case_source: "direct", client_gst_number: null, aggregator: null, ...o }) as unknown as CaseForInvoicing;

describe("computeCaseInvoice subtotal", () => {
  it.each([[6], [11], [12]])("bills the rate as is for %i months (unchanged)", (m) => {
    const p = computeCaseInvoice(base({ tenure_months: m }));
    expect(p.subtotal).toBe(18000);
    expect(p.gstAmount).toBe(3240);
    expect(p.total).toBe(21240);
  });
  it("bills rate when tenure is missing", () => {
    expect(computeCaseInvoice(base({ tenure_months: null })).subtotal).toBe(18000);
  });
  it.each([
    [24, 36000],
    [36, 54000],
    [48, 72000],
  ])("bills the annual rate x years for %i months", (m, sub) => {
    const p = computeCaseInvoice(base({ tenure_months: m }));
    expect(p.subtotal).toBe(sub);
    expect(p.total).toBe(sub * 1.18);
  });
});
