import { describe, it, expect } from "vitest";
import {
  checkInPaymentState,
  findDuplicateReference,
  hasProof,
  verifyExcess,
} from "../booking-payment-rules";

const upi = (amount: number, extra: Record<string, unknown> = {}) => ({
  amount,
  status: "pending",
  payment_mode: "upi",
  ...extra,
});

describe("checkInPaymentState", () => {
  it("blocks when nothing is paid", () => {
    const s = checkInPaymentState(2832, []);
    expect(s.covered).toBe(false);
    expect(s.isProvisional).toBe(false);
  });

  it("allows a verified payment in full, not provisional", () => {
    const s = checkInPaymentState(2832, [{ amount: 2832, status: "verified", payment_mode: "cash" }]);
    expect(s.covered).toBe(true);
    expect(s.isProvisional).toBe(false);
  });

  it("allows full pending UPI that has a screenshot, flagged provisional", () => {
    const s = checkInPaymentState(2832, [upi(2832, { screenshot_path: "payment-screenshots/x.png" })]);
    expect(s.covered).toBe(true);
    expect(s.isProvisional).toBe(true);
  });

  it("allows full pending UPI that has only a reference", () => {
    const s = checkInPaymentState(2832, [upi(2832, { payment_reference: "UTR123" })]);
    expect(s.covered).toBe(true);
    expect(s.isProvisional).toBe(true);
  });

  it("refuses pending UPI with no proof at all", () => {
    expect(checkInPaymentState(2832, [upi(2832)]).covered).toBe(false);
    expect(checkInPaymentState(2832, [upi(2832, { payment_reference: "  " })]).covered).toBe(false);
  });

  it("refuses a part-payment even with proof", () => {
    expect(checkInPaymentState(2832, [upi(1000, { payment_reference: "UTR1" })]).covered).toBe(false);
  });

  it("adds verified and provisional together", () => {
    const s = checkInPaymentState(2832, [
      { amount: 1000, status: "verified", payment_mode: "cash" },
      upi(1832, { payment_reference: "UTR2" }),
    ]);
    expect(s.covered).toBe(true);
    expect(s.isProvisional).toBe(true);
  });

  it("does not count pending razorpay or rejected rows", () => {
    const s = checkInPaymentState(2832, [
      { amount: 2832, status: "pending", payment_mode: "razorpay", payment_reference: "order_1" },
      { amount: 2832, status: "rejected", payment_mode: "upi", payment_reference: "UTR9" },
    ]);
    expect(s.covered).toBe(false);
  });
});

describe("verifyExcess", () => {
  it("is zero when the verified total still fits", () => {
    expect(verifyExcess(2832, 0, 2832)).toBe(0);
    expect(verifyExcess(2832, 1000, 1832)).toBe(0);
  });
  it("reports the rupees over", () => {
    expect(verifyExcess(2832, 2832, 2832)).toBe(2832);
    expect(verifyExcess(2832, 1000, 2000)).toBe(168);
  });
  it("tolerates rounding noise", () => {
    expect(verifyExcess(2832, 2832, 0.005)).toBe(0);
  });
});

describe("findDuplicateReference", () => {
  const existing = [
    { status: "pending", payment_reference: "UTR123" },
    { status: "rejected", payment_reference: "UTR999" },
  ];
  it("matches case-insensitively on a live payment", () => {
    expect(findDuplicateReference(existing, " utr123 ")).toBe(true);
  });
  it("ignores rejected payments and empty references", () => {
    expect(findDuplicateReference(existing, "UTR999")).toBe(false);
    expect(findDuplicateReference(existing, "")).toBe(false);
    expect(findDuplicateReference(existing, null)).toBe(false);
  });
});

describe("hasProof", () => {
  it("needs a screenshot or a non-blank reference", () => {
    expect(hasProof({ amount: 1, status: "pending", payment_mode: "upi" })).toBe(false);
    expect(hasProof({ amount: 1, status: "pending", payment_mode: "upi", screenshot_path: "p" })).toBe(true);
  });
});
