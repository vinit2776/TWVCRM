import { describe, expect, it } from "vitest";
import { sameInvoiceNumber } from "../invoice-number";

describe("sameInvoiceNumber", () => {
  it("ignores case, spaces and dash variants", () => {
    expect(sameInvoiceNumber("SD/A/26-27/467", "sd/a/26–27/467 ")).toBe(true);
    expect(sameInvoiceNumber("SD/A/26-27/467", "SD A 26 27 467")).toBe(true);
  });
  it("still tells different numbers apart", () => {
    expect(sameInvoiceNumber("SD/A/26-27/467", "SD/A/26-27/468")).toBe(false);
    expect(sameInvoiceNumber("SD/A/26-27/467", "SD/B/26-27/467")).toBe(false);
  });
  it("never matches empty input", () => {
    expect(sameInvoiceNumber("", "")).toBe(false);
    expect(sameInvoiceNumber("SD/A/1", "")).toBe(false);
  });
});
