import { describe, it, expect } from "vitest";
import {
  canOverrideDepositFloor,
  canRequestDepositInstalment,
  checkAsk,
  depositPosition,
  instalmentErrorMessage,
  minFirstPart,
  requiredDeposit,
} from "../deposit-instalments";

describe("requiredDeposit", () => {
  it("nets credit and exception", () => {
    expect(requiredDeposit({ security_deposit_amount: 60000 })).toBe(60000);
    expect(requiredDeposit({ security_deposit_amount: 60000, deposit_credit_amount: 10000 })).toBe(50000);
    expect(requiredDeposit({ security_deposit_amount: 60000, deposit_exception_amount: -5000 })).toBe(55000);
    expect(requiredDeposit({ security_deposit_amount: "36000.00" })).toBe(36000);
  });
  it("never goes negative", () => {
    expect(requiredDeposit({ security_deposit_amount: 1000, deposit_credit_amount: 5000 })).toBe(0);
  });
});

describe("depositPosition", () => {
  it("matches the worked example: ₹20k paid, ₹15k awaiting, of ₹60k", () => {
    const pos = depositPosition(60000, [
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 15000, status: "requested" },
    ]);
    expect(pos).toMatchObject({ required: 60000, requested: 35000, paid: 20000, awaiting: 15000, notYetAsked: 25000, balance: 40000, partsPaid: 1 });
  });
  it("ties out: required − paid = balance, requested − paid = awaiting", () => {
    const pos = depositPosition(60000, [
      { amount: 20000, status: "paid", paid_amount: 20000 },
      { amount: 15000, status: "requested" },
    ]);
    expect(pos.required - pos.paid).toBe(pos.balance);
    expect(pos.requested - pos.paid).toBe(pos.awaiting);
    expect(pos.required - pos.requested).toBe(pos.notYetAsked);
  });
  it("ignores cancelled asks, so the amount returns to not-yet-asked", () => {
    const pos = depositPosition(60000, [{ amount: 15000, status: "cancelled" }]);
    expect(pos.requested).toBe(0);
    expect(pos.notYetAsked).toBe(60000);
  });
  it("counts a late payment on a cancelled ask as paid", () => {
    const pos = depositPosition(60000, [{ amount: 15000, status: "paid", paid_amount: 15000 }]);
    expect(pos.paid).toBe(15000);
  });
  it("does not report a negative balance on over-payment", () => {
    const pos = depositPosition(60000, [{ amount: 70000, status: "paid", paid_amount: 70000 }]);
    expect(pos.balance).toBe(0);
    expect(pos.notYetAsked).toBe(0);
  });
});

describe("minFirstPart / checkAsk", () => {
  it("rounds the 25% floor up", () => {
    expect(minFirstPart(60000)).toBe(15000);
    expect(minFirstPart(36000)).toBe(9000);
    expect(minFirstPart(13650)).toBe(3413);
  });
  const fresh = depositPosition(60000, []);
  it("flags a first part below the floor as needing an override", () => {
    expect(checkAsk(10000, fresh, false)).toEqual({ ok: true, needsOverride: true });
    expect(checkAsk(15000, fresh, false)).toEqual({ ok: true, needsOverride: false });
  });
  it("lets the whole balance through even if the floor were higher", () => {
    expect(checkAsk(60000, fresh, false, 100)).toEqual({ ok: true, needsOverride: false });
  });
  it("applies no floor to later parts", () => {
    const later = depositPosition(60000, [{ amount: 15000, status: "paid", paid_amount: 15000 }]);
    expect(checkAsk(500, later, false)).toEqual({ ok: true, needsOverride: false });
  });
  it("refuses more than the balance, a second open ask and non-positive amounts", () => {
    const later = depositPosition(60000, [{ amount: 15000, status: "paid", paid_amount: 15000 }]);
    expect(checkAsk(50000, later, false)).toMatchObject({ ok: false, code: "amount_exceeds_balance", balance: 45000 });
    expect(checkAsk(1000, later, true)).toMatchObject({ ok: false, code: "open_ask_exists" });
    expect(checkAsk(0, later, false)).toMatchObject({ ok: false, code: "amount_invalid" });
  });
});

describe("roles and wording", () => {
  it("lets admin, manager and sales rep ask; only admin and manager override", () => {
    expect(["admin", "manager", "sales_rep"].every(canRequestDepositInstalment)).toBe(true);
    expect(canRequestDepositInstalment("accounts")).toBe(false);
    expect(canOverrideDepositFloor("sales_rep")).toBe(false);
    expect(canOverrideDepositFloor("manager")).toBe(true);
  });
  it("explains the floor in rupees", () => {
    expect(instalmentErrorMessage("below_floor", { floor: 15000, percent: 25 })).toContain("₹15,000");
  });
});
