import { describe, it, expect } from "vitest";
import {
  isUnverifiedDeposit,
  unverifiedPortionOfApplicable,
  type PoolDepositContractRow,
} from "../deposit-evidence";

const row = (over: Partial<PoolDepositContractRow>): PoolDepositContractRow => ({
  contract_number: "TWV-C-0001",
  deposit_payment_status: "paid",
  deposit_payment_amount: 10000,
  security_deposit_amount: 10000,
  deposit_refunded_amount: null,
  deposit_payment_reference: "pay_ABC123",
  ...over,
});

const LEGACY = "Legacy — payment assumed received pre-application";

describe("isUnverifiedDeposit", () => {
  it("flags the legacy import stamp", () => {
    expect(isUnverifiedDeposit(row({ deposit_payment_reference: LEGACY }))).toBe(true);
  });

  it("flags a paid deposit with no recorded amount", () => {
    expect(isUnverifiedDeposit(row({ deposit_payment_amount: null, deposit_payment_reference: null }))).toBe(true);
  });

  it("trusts a real payment reference with an amount", () => {
    expect(isUnverifiedDeposit(row({}))).toBe(false);
  });

  it("ignores deposits that are not paid", () => {
    expect(isUnverifiedDeposit(row({ deposit_payment_status: "pending", deposit_payment_reference: LEGACY }))).toBe(false);
  });
});

describe("unverifiedPortionOfApplicable", () => {
  it("TWV-C-0150: the whole ₹9,900 rests on the legacy ₹11,000", () => {
    const rows = [
      row({ contract_number: "TWV-C-0066", deposit_payment_reference: LEGACY, deposit_payment_amount: 11000, security_deposit_amount: 11000 }),
      row({ contract_number: "TWV-C-0098", deposit_payment_status: "not_required", deposit_payment_amount: null, security_deposit_amount: 0 }),
    ];
    expect(unverifiedPortionOfApplicable(rows, 9900, 1100)).toEqual({ amount: 9900, contractNumbers: ["TWV-C-0066"] });
  });

  it("falls back to the required amount when no amount was recorded, matching the pool RPC", () => {
    const rows = [row({ deposit_payment_amount: null, security_deposit_amount: 11000, deposit_payment_reference: null })];
    expect(unverifiedPortionOfApplicable(rows, 9900, 1100).amount).toBe(9900);
  });

  it("is zero when verified money covers the whole application", () => {
    const rows = [row({ deposit_payment_amount: 20000 })];
    expect(unverifiedPortionOfApplicable(rows, 9900, 1100)).toEqual({ amount: 0, contractNumbers: [] });
  });

  it("only flags the part verified money cannot cover", () => {
    const rows = [
      row({ contract_number: "A", deposit_payment_amount: 5000 }),
      row({ contract_number: "B", deposit_payment_reference: LEGACY, deposit_payment_amount: 6000 }),
    ];
    // pool 11,000; others need 1,000 → verified 5,000 covers 4,000 of the 9,900 applied
    expect(unverifiedPortionOfApplicable(rows, 9900, 1000)).toEqual({ amount: 5900, contractNumbers: ["B"] });
  });

  it("subtracts refunds and never exceeds the unverified total", () => {
    const rows = [row({ deposit_payment_reference: LEGACY, deposit_payment_amount: 11000, deposit_refunded_amount: 8000 })];
    expect(unverifiedPortionOfApplicable(rows, 9900, 0).amount).toBe(3000);
  });

  it("counts paid top-ups as verified and committed adjustments against it", () => {
    const rows = [row({ deposit_payment_reference: LEGACY, deposit_payment_amount: 11000 })];
    expect(unverifiedPortionOfApplicable(rows, 9900, 1100, 3000, 0).amount).toBe(8000);
    expect(unverifiedPortionOfApplicable(rows, 9900, 1100, 3000, 3000).amount).toBe(9900);
  });

  it("is zero when nothing is applicable", () => {
    const rows = [row({ deposit_payment_reference: LEGACY })];
    expect(unverifiedPortionOfApplicable(rows, 0, 0).amount).toBe(0);
  });
});
