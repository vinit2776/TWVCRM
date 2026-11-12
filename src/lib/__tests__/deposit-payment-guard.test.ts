import { describe, it, expect } from "vitest";
import { evaluateDepositGuard, mentionsDeposit } from "../deposit-payment-guard";

const base = { mode: "other", depositAvailable: 14160 };

describe("evaluateDepositGuard", () => {
  it("blocks Other while a deposit is available", () => {
    const r = evaluateDepositGuard(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DEPOSIT_AVAILABLE");
  });

  it("blocks a bank mode whose narration says deposit adjustment", () => {
    expect(evaluateDepositGuard({ mode: "neft", depositAvailable: 100, notes: "ADJUSTED SECURITY DEPOSIT" }).ok).toBe(false);
    expect(evaluateDepositGuard({ mode: "bank_transfer", depositAvailable: 100, reference: "Adjusted Deposit" }).ok).toBe(false);
  });

  it("blocks Hindi narration", () => {
    expect(evaluateDepositGuard({ mode: "cash", depositAvailable: 100, notes: "सिक्योरिटी डिपॉज़िट से एडजस्ट" }).ok).toBe(false);
  });

  it("lets a normal bank receipt through even when a deposit exists", () => {
    expect(evaluateDepositGuard({ mode: "neft", depositAvailable: 14160, reference: "UTR123456" }).ok).toBe(true);
    expect(evaluateDepositGuard({ mode: "cash", depositAvailable: 14160 }).ok).toBe(true);
  });

  it("never blocks deposit_adjustment itself", () => {
    expect(evaluateDepositGuard({ mode: "deposit_adjustment", depositAvailable: 500, notes: "deposit" }).ok).toBe(true);
  });

  it("passes when no deposit is available, or the lookup failed", () => {
    expect(evaluateDepositGuard({ ...base, depositAvailable: 0 }).ok).toBe(true);
    expect(evaluateDepositGuard({ ...base, depositAvailable: null }).ok).toBe(true);
  });

  it("accepts an override with a long enough reason and flags it", () => {
    const r = evaluateDepositGuard({ ...base, overrideReason: "Customer paid by NEFT, UTR on statement" });
    expect(r).toEqual({ ok: true, overridden: true });
  });

  it("rejects a too-short override reason", () => {
    const r = evaluateDepositGuard({ ...base, overrideReason: "bank" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OVERRIDE_REASON_TOO_SHORT");
  });
});

describe("mentionsDeposit", () => {
  it.each(["Adjusted Deposit", "ADJUSTED SECURITY DEPOSIT", "Deposit adj.", "security-deposit", "adjusted towards July invoice"])(
    "matches %s", (t) => expect(mentionsDeposit(t)).toBe(true));
  it.each(["UTR 123456", "HDFC NEFT", "", null, undefined, "cheque 000123"])(
    "ignores %s", (t) => expect(mentionsDeposit(t)).toBe(false));
});
