import { describe, it, expect } from "vitest";
import {
  baseProposalNumber,
  revisionBlockedReason,
  revisionProposalNumber,
  revisionTotals,
} from "../proposal-revision";

describe("revision numbering", () => {
  it("adds -R2 to an original proposal", () => {
    expect(revisionProposalNumber("PROP-0231", 1)).toBe("PROP-0231-R2");
  });

  it("counts on from the previous revision without stacking suffixes", () => {
    expect(revisionProposalNumber("PROP-0231-R2", 2)).toBe("PROP-0231-R3");
    expect(baseProposalNumber("PROP-0231-R12")).toBe("PROP-0231");
  });

  it("leaves a number that was never revised alone", () => {
    expect(baseProposalNumber("PROP-0231")).toBe("PROP-0231");
  });

  it("treats a missing revision number as the original", () => {
    expect(revisionProposalNumber("PROP-0007", 0)).toBe("PROP-0007-R2");
  });
});

describe("revisionBlockedReason", () => {
  const sent = { status: "sent", deposit_payment_status: "pending", payment_status: "pending" };

  it("allows a sent or viewed proposal with no money collected", () => {
    expect(revisionBlockedReason(sent)).toBeNull();
    expect(revisionBlockedReason({ ...sent, status: "viewed" })).toBeNull();
    expect(revisionBlockedReason({ status: "sent" })).toBeNull();
  });

  it("blocks once the deposit is paid", () => {
    expect(revisionBlockedReason({ ...sent, deposit_payment_status: "paid" })).toMatch(/money/i);
  });

  it("blocks once the pro-rata is paid", () => {
    expect(revisionBlockedReason({ ...sent, payment_status: "paid" })).toMatch(/money/i);
  });

  it("blocks when a deposit credit has been applied", () => {
    expect(revisionBlockedReason({ ...sent, deposit_credit_amount: 5000 })).toMatch(/credited/i);
    expect(revisionBlockedReason({ ...sent, deposit_credit_amount: "0" })).toBeNull();
  });

  it("sends staff to the right place for each non-revisable status", () => {
    expect(revisionBlockedReason({ status: "accepted" })).toMatch(/new proposal/i);
    expect(revisionBlockedReason({ status: "draft" })).toMatch(/edited directly/i);
    expect(revisionBlockedReason({ status: "rejected" })).toMatch(/edited directly/i);
    expect(revisionBlockedReason({ status: "superseded" })).toMatch(/already been replaced/i);
    expect(revisionBlockedReason({ status: "expired" })).toMatch(/can't be revised/i);
  });
});

describe("revisionTotals", () => {
  const items = [{ total: 10000 }, { total: 5000 }];

  it("computes totals and the deposit like proposal creation", () => {
    const t = revisionTotals({ items, tax_percentage: 18, discount_percentage: 10, security_deposit_months: 2 });
    expect(t.subtotal).toBe(15000);
    expect(t.tax_amount).toBe(2700);
    expect(t.discount_amount).toBe(1500);
    expect(t.total_amount).toBe(16200);
    expect(t.security_deposit_amount).toBe(30000);
    expect(t.deposit_payment_status).toBe("pending");
  });

  it("resets the deposit status when the revision drops the deposit", () => {
    const t = revisionTotals({ items, tax_percentage: 18, discount_percentage: 0, security_deposit_months: 0 });
    expect(t.deposit_payment_status).toBe("not_required");
    expect(t.security_deposit_amount).toBe(0);
  });

  it("recomputes the deposit when months go from none to some", () => {
    const t = revisionTotals({ items, tax_percentage: 18, discount_percentage: 0, security_deposit_months: 3 });
    expect(t.deposit_payment_status).toBe("pending");
    expect(t.security_deposit_amount).toBe(45000);
  });

  it("honours an explicit deposit amount", () => {
    const t = revisionTotals({ items, tax_percentage: 18, discount_percentage: 0, security_deposit_months: 2, security_deposit_amount: 25000 });
    expect(t.security_deposit_amount).toBe(25000);
  });
});
