import { describe, it, expect } from "vitest";
import { clearanceBlockers, computeClearance, maskAccount, validateBankDetails } from "../exit-settlement";

describe("computeClearance", () => {
  it("refunds the deposit left after charges", () => {
    expect(computeClearance(100000, 16700)).toEqual({ outcome: "refund", retained: 16700, refund: 83300, owed: 0 });
  });
  it("retains the whole deposit and records what is owed when charges exceed it", () => {
    expect(computeClearance(30000, 26000 + 14160)).toEqual({ outcome: "owed", retained: 30000, refund: 0, owed: 10160 });
  });
  it("owes everything when no deposit is held", () => {
    expect(computeClearance(0, 5000)).toEqual({ outcome: "owed", retained: 0, refund: 0, owed: 5000 });
  });
  it("is nil when there is nothing either way", () => {
    expect(computeClearance(0, 0)).toEqual({ outcome: "nil", retained: 0, refund: 0, owed: 0 });
    expect(computeClearance(5000, 5000)).toEqual({ outcome: "nil", retained: 5000, refund: 0, owed: 0 });
  });
  it("never produces a negative amount and avoids float drift", () => {
    const c = computeClearance(100, 0.3);
    expect(c.refund).toBe(99.7);
    expect(computeClearance(-5, 10).owed).toBe(10);
  });
});

describe("clearanceBlockers", () => {
  const ok = { exitStatus: "completed", inspectionDone: true, unpaidInvoices: 0, unbilledUsage: 0, hasLiveSettlement: false };
  it("allows a completed, inspected, clean exit", () => {
    expect(clearanceBlockers(ok)).toEqual([]);
  });
  it("lists every reason", () => {
    const r = clearanceBlockers({ exitStatus: "in_notice", inspectionDone: false, unpaidInvoices: 100, unbilledUsage: 50, hasLiveSettlement: true });
    expect(r).toHaveLength(5);
  });
});

describe("validateBankDetails", () => {
  it("accepts a plain account and IFSC", () => {
    expect(validateBankDetails({ bank_account_name: "Acme", bank_account_number: "123456789012", bank_ifsc: "hdfc0001234" })).toBeNull();
  });
  it("rejects bad input", () => {
    expect(validateBankDetails({ bank_account_name: "", bank_account_number: "1234567", bank_ifsc: "HDFC0001234" })).toMatch(/name/);
    expect(validateBankDetails({ bank_account_name: "A", bank_account_number: "12ab", bank_ifsc: "HDFC0001234" })).toMatch(/account number/);
    expect(validateBankDetails({ bank_account_name: "A", bank_account_number: "1234567", bank_ifsc: "XX" })).toMatch(/IFSC/);
  });
  it("masks all but the last four digits", () => {
    expect(maskAccount("123456789012")).toBe("••••9012");
    expect(maskAccount(null)).toBe("");
  });
});
