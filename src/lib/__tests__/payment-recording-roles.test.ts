import { describe, it, expect } from "vitest";
import { PAYMENT_RECORDING_ROLES, canRecordPayments, USER_ROLES } from "@/lib/constants";

describe("canRecordPayments", () => {
  it("admits admin and accounts", () => {
    expect(canRecordPayments("admin")).toBe(true);
    expect(canRecordPayments("accounts")).toBe(true);
  });

  it("excludes manager, who now uses Report paid instead", () => {
    expect(canRecordPayments("manager")).toBe(false);
  });

  it("excludes every other role, including unknown and empty ones", () => {
    const allowed = new Set<string>(PAYMENT_RECORDING_ROLES);
    for (const role of USER_ROLES) {
      if (allowed.has(role)) continue;
      expect(canRecordPayments(role)).toBe(false);
    }
    expect(canRecordPayments(null)).toBe(false);
    expect(canRecordPayments(undefined)).toBe(false);
    expect(canRecordPayments("")).toBe(false);
    expect(canRecordPayments("ADMIN")).toBe(false);
  });

  it("stays narrower than the roles that can merely see receivables", () => {
    // The AR page is open to admin, manager, accounts and sales_rep. If this
    // ever matched that list, the split this change exists to create — see
    // it, report it, but don't record it — would be gone.
    const arViewers = ["admin", "manager", "accounts", "sales_rep"];
    expect(arViewers.filter(canRecordPayments)).toEqual(["admin", "accounts"]);
  });
});
