import { describe, it, expect } from "vitest";
import { evaluateAutoApproval, computeOverdueStatus, type RecurringBillRuleLike } from "../procurement/recurring-bill-rules";

const baseRule: RecurringBillRuleLike = {
  expected_amount: 1200,
  tolerance_percent: 10,
  max_auto_approve_amount: 5000,
  first_bill_id: "first-bill-id", // rule already has an established track record
};

describe("evaluateAutoApproval", () => {
  it("auto-approves a bill within tolerance and cap, no duplicate", () => {
    const result = evaluateAutoApproval(
      baseRule,
      { total_amount: 1240, invoice_number: "INV-88213", invoice_date: "2026-08-03" },
      [],
    );
    expect(result.approved).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it("falls back to manual when the very first bill under the rule hasn't been confirmed", () => {
    const rule: RecurringBillRuleLike = { ...baseRule, first_bill_id: null };
    const result = evaluateAutoApproval(
      rule,
      { total_amount: 1200, invoice_number: "INV-01", invoice_date: "2026-07-28" },
      [],
    );
    expect(result.approved).toBe(false);
    const firstBillCheck = result.checks.find((c) => c.key === "first_bill");
    expect(firstBillCheck?.pass).toBe(false);
  });

  it("falls back to manual when the amount exceeds tolerance", () => {
    const rule: RecurringBillRuleLike = { ...baseRule, expected_amount: 18000, tolerance_percent: 8, max_auto_approve_amount: 22000 };
    const result = evaluateAutoApproval(
      rule,
      { total_amount: 24900, invoice_number: "INV-55021", invoice_date: "2026-08-02" },
      [],
    );
    expect(result.approved).toBe(false);
    expect(result.checks.find((c) => c.key === "variance")?.pass).toBe(false);
    expect(result.checks.find((c) => c.key === "cap")?.pass).toBe(false);
  });

  it("falls back to manual when the amount exceeds the hard cap even if within tolerance percent", () => {
    const rule: RecurringBillRuleLike = { ...baseRule, expected_amount: 4900, tolerance_percent: 50, max_auto_approve_amount: 5000 };
    const result = evaluateAutoApproval(
      rule,
      { total_amount: 5500, invoice_number: "INV-9", invoice_date: "2026-08-03" },
      [],
    );
    expect(result.checks.find((c) => c.key === "variance")?.pass).toBe(true);
    expect(result.checks.find((c) => c.key === "cap")?.pass).toBe(false);
    expect(result.approved).toBe(false);
  });

  it("flags an exact invoice-number match as a duplicate", () => {
    const result = evaluateAutoApproval(
      baseRule,
      { total_amount: 1240, invoice_number: "inv-88213 ", invoice_date: "2026-08-03" },
      [{ id: "b1", invoice_number: "INV-88213", invoice_date: "2026-08-01", total_amount: 1240 }],
    );
    expect(result.checks.find((c) => c.key === "duplicate")?.pass).toBe(false);
    expect(result.approved).toBe(false);
  });

  it("flags a same-amount bill within 3 days as a likely duplicate even with a different invoice number", () => {
    const result = evaluateAutoApproval(
      baseRule,
      { total_amount: 1240, invoice_number: "INV-NEW", invoice_date: "2026-08-03" },
      [{ id: "b1", invoice_number: "INV-OLD", invoice_date: "2026-08-01", total_amount: 1240 }],
    );
    expect(result.checks.find((c) => c.key === "duplicate")?.pass).toBe(false);
  });

  it("does not flag a same-amount bill more than 3 days apart", () => {
    const result = evaluateAutoApproval(
      baseRule,
      { total_amount: 1240, invoice_number: "INV-NEW", invoice_date: "2026-08-10" },
      [{ id: "b1", invoice_number: "INV-OLD", invoice_date: "2026-08-01", total_amount: 1240 }],
    );
    expect(result.checks.find((c) => c.key === "duplicate")?.pass).toBe(true);
  });
});

describe("computeOverdueStatus", () => {
  it("is not overdue within the monthly cycle + grace period", () => {
    const status = computeOverdueStatus("monthly", "2026-07-05", "2026-08-05");
    expect(status.overdue).toBe(false);
  });

  it("is overdue once a monthly cycle + grace period has passed with no new bill", () => {
    const status = computeOverdueStatus("monthly", "2026-06-01", "2026-08-05");
    expect(status.overdue).toBe(true);
    expect(status.daysOverdue).toBeGreaterThan(0);
  });

  it("respects longer cycles — a quarterly bill isn't overdue after 6 weeks", () => {
    const status = computeOverdueStatus("quarterly", "2026-07-01", "2026-08-15");
    expect(status.overdue).toBe(false);
  });
});
