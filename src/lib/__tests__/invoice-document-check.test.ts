import { describe, expect, it } from "vitest";
import { looksLikeTaxInvoice } from "../invoice-document-check";

describe("looksLikeTaxInvoice", () => {
  it("accepts a Tally invoice by its number", () => {
    expect(looksLikeTaxInvoice("Invoice No. SD/A/26-27/475 Dated 02-Nov-2026")).toBe(true);
  });
  it("accepts a document titled Tax Invoice", () => {
    expect(looksLikeTaxInvoice("TAX INVOICE\nBuyer: ABC Ltd")).toBe(true);
  });
  it("rejects an agreement or other document", () => {
    expect(looksLikeTaxInvoice("LEAVE AND LICENSE AGREEMENT between the parties")).toBe(false);
    expect(looksLikeTaxInvoice("Bank statement for October 2026")).toBe(false);
  });
  it("rejects a credit note or proforma that mentions tax invoice", () => {
    expect(looksLikeTaxInvoice("CREDIT NOTE against Tax Invoice no 12")).toBe(false);
    expect(looksLikeTaxInvoice("PROFORMA INVOICE - not a tax invoice")).toBe(false);
  });
  it("cannot judge empty text", () => {
    expect(looksLikeTaxInvoice("   ")).toBeNull();
  });
});
