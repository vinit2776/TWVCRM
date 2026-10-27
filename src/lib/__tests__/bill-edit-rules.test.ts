import { describe, it, expect } from "vitest";
import {
  canEditBill,
  billEditLockReason,
  classifyAmountChange,
  approvalAfterAmountChange,
  checkAmountAgainstCeiling,
} from "@/lib/procurement/bill-edit-rules";

describe("canEditBill", () => {
  it("lets admin, manager and office_admin edit any bill", () => {
    for (const role of ["admin", "manager", "office_admin"]) {
      expect(canEditBill({ role, userId: "u1", createdBy: "u2" })).toBe(true);
    }
  });
  it("lets the creator edit whatever their role", () => {
    expect(canEditBill({ role: "sales_rep", userId: "u1", createdBy: "u1" })).toBe(true);
  });
  it("keeps accounts out unless they created the bill", () => {
    expect(canEditBill({ role: "accounts", userId: "u1", createdBy: "u2" })).toBe(false);
    expect(canEditBill({ role: "accounts", userId: "u1", createdBy: "u1" })).toBe(true);
  });
  it("does not match on a missing creator", () => {
    expect(canEditBill({ role: "fms", userId: "u1", createdBy: null })).toBe(false);
  });
});

describe("billEditLockReason", () => {
  const open = { approvalStatus: "approved", standingPaymentCount: 0, paymentStatus: "unpaid" };
  it("is open for pending, rejected and approved-unpaid bills", () => {
    for (const approvalStatus of ["pending", "rejected", "approved"]) {
      expect(billEditLockReason({ ...open, approvalStatus })).toBeNull();
    }
  });
  it("locks once a payment stands", () => {
    expect(billEditLockReason({ ...open, standingPaymentCount: 1 })).toMatch(/payment has been recorded/);
    expect(billEditLockReason({ ...open, paymentStatus: "partially_paid" })).not.toBeNull();
  });
  it("is open again when all payments were reversed", () => {
    expect(billEditLockReason({ ...open, standingPaymentCount: 0, paymentStatus: "unpaid" })).toBeNull();
  });
  it("locks withdrawn bills and signed cheques", () => {
    expect(billEditLockReason({ ...open, approvalStatus: "withdrawn" })).toMatch(/withdrawn/);
    expect(billEditLockReason({ ...open, chequeSigned: true })).toMatch(/cheque/);
  });
});

describe("amount change handling", () => {
  it("classifies the change", () => {
    expect(classifyAmountChange(18213, 15435)).toBe("lowered");
    expect(classifyAmountChange(15435, 15435.004)).toBe("unchanged");
    expect(classifyAmountChange(100, 120)).toBe("raised");
  });
  it("only sends an approved bill back when the amount is raised", () => {
    expect(approvalAfterAmountChange("approved", "raised")).toBe("reset");
    expect(approvalAfterAmountChange("approved", "lowered")).toBe("keep");
    expect(approvalAfterAmountChange("approved", "unchanged")).toBe("keep");
    expect(approvalAfterAmountChange("pending", "raised")).toBe("keep");
  });
});

describe("checkAmountAgainstCeiling", () => {
  const base = { isService: false, ceiling: 15435, priorInvoiced: 0, tolerancePercent: 0 };
  it("refuses a GST-inclusive amount above a firm PO", () => {
    const r = checkAmountAgainstCeiling({ ...base, newTotal: 18213 });
    expect(r.ok).toBe(false);
  });
  it("accepts the pre-GST amount", () => {
    expect(checkAmountAgainstCeiling({ ...base, newTotal: 15435 }).ok).toBe(true);
  });
  it("counts other live bills on a goods PO", () => {
    const r = checkAmountAgainstCeiling({ ...base, newTotal: 10000, priorInvoiced: 6000 });
    expect(r.ok).toBe(false);
  });
  it("lets a flexible PO drift inside its band but not past it", () => {
    const flex = { ...base, tolerancePercent: 5 };
    expect(checkAmountAgainstCeiling({ ...flex, newTotal: 16000 }).ok).toBe(true);
    expect(checkAmountAgainstCeiling({ ...flex, newTotal: 17000 }).ok).toBe(false);
  });
  it("uses the cycle cost for service POs and ignores prior bills", () => {
    const svc = { isService: true, ceiling: 5000, priorInvoiced: 5000, tolerancePercent: 10 };
    expect(checkAmountAgainstCeiling({ ...svc, newTotal: 5000 }).ok).toBe(true);
    expect(checkAmountAgainstCeiling({ ...svc, newTotal: 5100 }).ok).toBe(false);
  });
  it("has nothing to check without a ceiling", () => {
    expect(checkAmountAgainstCeiling({ ...base, ceiling: null, newTotal: 999999 }).ok).toBe(true);
  });
});
