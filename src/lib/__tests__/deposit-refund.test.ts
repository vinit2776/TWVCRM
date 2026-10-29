import { describe, expect, it } from "vitest";
import { canRequestDepositRefund, depositRefundErrorMessage, DEPOSIT_REFUND_APPROVE_ROLES, DEPOSIT_REFUND_PAY_ROLES } from "../deposit-refund";

describe("deposit refund rules", () => {
  it("manager, sales rep and admin request; accounts does not", () => {
    expect(canRequestDepositRefund("sales_rep")).toBe(true);
    expect(canRequestDepositRefund("manager")).toBe(true);
    expect(canRequestDepositRefund("accounts")).toBe(false);
    expect(canRequestDepositRefund(null)).toBe(false);
  });
  it("only an admin approves; accounts and admin pay", () => {
    expect([...DEPOSIT_REFUND_APPROVE_ROLES]).toEqual(["admin"]);
    expect([...DEPOSIT_REFUND_PAY_ROLES]).toEqual(["admin", "accounts"]);
  });
  it("explains why a complete deposit or an existing contract cannot use this path", () => {
    expect(depositRefundErrorMessage("deposit_complete")).toMatch(/contract exit/);
    expect(depositRefundErrorMessage("contract_exists")).toMatch(/contract exit/);
    expect(depositRefundErrorMessage("nope")).toMatch(/Could not/);
  });
});
