import { describe, it, expect } from "vitest";
import {
  billedToOf,
  requiresPaidInvoice,
  paymentGateAllows,
  type BilledTo,
  type PaymentOverride,
} from "@/lib/vo-execution-gate";

const override: PaymentOverride = { reason: "Owner approved, cheque in transit", by: "u1", at: "2026-01-01T00:00:00Z" };

describe("billedToOf", () => {
  it("is direct with no aggregator", () => {
    expect(billedToOf({ aggregatorId: null })).toBe("direct");
  });
  it("reads prepaid and postpaid from the aggregator", () => {
    expect(billedToOf({ aggregatorId: "a", billingMethod: "prepaid" })).toBe("prepaid");
    expect(billedToOf({ aggregatorId: "a", billingMethod: "postpaid" })).toBe("postpaid");
  });
  it("keeps an unset method distinct", () => {
    expect(billedToOf({ aggregatorId: "a", billingMethod: null })).toBe("unspecified");
  });
});

describe("requiresPaidInvoice (postpaid exemption)", () => {
  it("requires payment for direct and prepaid", () => {
    expect(requiresPaidInvoice("direct")).toBe(true);
    expect(requiresPaidInvoice("prepaid")).toBe(true);
  });
  it("exempts postpaid, and unset keeps the historical exemption", () => {
    expect(requiresPaidInvoice("postpaid")).toBe(false);
    expect(requiresPaidInvoice("unspecified")).toBe(false);
  });
});

describe("paymentGateAllows matrix", () => {
  const cases: BilledTo[] = ["direct", "prepaid", "postpaid"];
  for (const billedTo of cases) {
    for (const paid of [true, false]) {
      for (const withOverride of [true, false]) {
        const expected = billedTo === "postpaid" || paid || withOverride;
        it(`${billedTo} paid=${paid} override=${withOverride} -> ${expected}`, () => {
          expect(
            paymentGateAllows({ billedTo, paid, override: withOverride ? override : null }),
          ).toBe(expected);
        });
      }
    }
  }
});
