import { describe, expect, it } from "vitest";
import { extractInvoicePeriodMonths, invoicePeriodMismatch } from "../invoice-period-text";

describe("extractInvoicePeriodMonths", () => {
  it("reads a dd-MMM-yyyy range", () => {
    expect(extractInvoicePeriodMonths("Rent 01-Nov-2026 to 30-Nov-2026 SAC 997212")).toEqual(["2026-11"]);
  });
  it("reads a dd/mm/yyyy range and a dash separator", () => {
    expect(extractInvoicePeriodMonths("Rent 01/10/2026 - 31/10/2026")).toEqual(["2026-10"]);
  });
  it("reads a 'for <Month> <year>' phrase", () => {
    expect(extractInvoicePeriodMonths("Office rent for November 2026")).toEqual(["2026-11"]);
    expect(extractInvoicePeriodMonths("Rent for the month of Oct 2026")).toEqual(["2026-10"]);
  });
  it("spans every month in a multi-month range", () => {
    expect(extractInvoicePeriodMonths("01-Oct-2026 to 31-Dec-2026")).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
  it("does not treat the invoice's own date as a period", () => {
    expect(extractInvoicePeriodMonths("Invoice No. SD/A/26-27/476 Dated 02-Nov-2026")).toEqual([]);
  });
});

describe("invoicePeriodMismatch", () => {
  it("flags a November invoice on an October statement", () => {
    expect(invoicePeriodMismatch(["2026-11"], "2026-10-04", "2026-10-31")).toBe(true);
  });
  it("accepts the matching month, including a pro-rata statement", () => {
    expect(invoicePeriodMismatch(["2026-10"], "2026-10-04", "2026-10-31")).toBe(false);
  });
  it("accepts any overlap", () => {
    expect(invoicePeriodMismatch(["2026-10", "2026-11"], "2026-11-01", "2026-11-30")).toBe(false);
  });
  it("is silent when the invoice names no period", () => {
    expect(invoicePeriodMismatch([], "2026-10-04", "2026-10-31")).toBe(false);
    expect(invoicePeriodMismatch(null, "2026-10-04", "2026-10-31")).toBe(false);
  });
});
