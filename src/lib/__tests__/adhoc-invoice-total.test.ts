import { describe, it, expect } from "vitest";
import { adhocInvoiceTotal } from "../adhoc-invoice-total";
import { settlementAmount, settlementStatus } from "../settlement";

describe("adhocInvoiceTotal", () => {
  it("rounds the INV-0060 paise total to the whole rupee", () => {
    expect(adhocInvoiceTotal(8476, 1525.68)).toBe(10002);
  });

  it("applies the discount before rounding", () => {
    expect(adhocInvoiceTotal(1000, 180, 100.4)).toBe(1080);
  });

  it("leaves an already-whole total alone", () => {
    expect(adhocInvoiceTotal(1000, 180)).toBe(1180);
  });

  it("makes paying the link in full settle the statement", () => {
    const linkAmount = adhocInvoiceTotal(8476, 1525.68);
    expect(settlementStatus(linkAmount, linkAmount)).toBe("paid");
    // The old behaviour: paying the unrounded amount against a statement that
    // settles on the rounded one left it short.
    expect(settlementStatus(10001.68, 10001.68)).toBe("partially_paid");
    expect(settlementAmount(10001.68)).toBe(10002);
  });
});
