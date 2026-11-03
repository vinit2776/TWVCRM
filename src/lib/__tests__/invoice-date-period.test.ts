import { describe, expect, it } from "vitest";
import { isInvoiceDateOffPeriod } from "../invoice-date-period";

describe("isInvoiceDateOffPeriod", () => {
  it("flags a November invoice for an October cycle", () => {
    expect(isInvoiceDateOffPeriod("2026-11-02", "2026-10-04", "2026-10-31")).toBe(true);
  });
  it("accepts an invoice dated inside the period's month", () => {
    expect(isInvoiceDateOffPeriod("2026-10-01", "2026-10-04", "2026-10-31")).toBe(false);
    expect(isInvoiceDateOffPeriod("2026-10-31", "2026-10-04", "2026-10-31")).toBe(false);
  });
  it("flags an invoice dated before the period's month", () => {
    expect(isInvoiceDateOffPeriod("2026-09-30", "2026-10-04", "2026-10-31")).toBe(true);
  });
  it("accepts any month a multi-month period spans", () => {
    expect(isInvoiceDateOffPeriod("2026-11-15", "2026-10-01", "2026-12-31")).toBe(false);
  });
  it("does not flag when a date is missing", () => {
    expect(isInvoiceDateOffPeriod("2026-11-02", null, "2026-10-31")).toBe(false);
    expect(isInvoiceDateOffPeriod("", "2026-10-04", "2026-10-31")).toBe(false);
  });
});
