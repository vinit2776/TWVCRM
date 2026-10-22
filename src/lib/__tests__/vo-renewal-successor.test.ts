import { describe, expect, it } from "vitest";
import { successorCaseRow } from "@/lib/vo-renewal-successor";

const previous = {
  id: "case-1",
  case_number: "TWV-CASE-0001",
  status: "grace_period",
  parent_case_id: null,
  start_date: "2025-12-01",
  end_date: "2026-11-30",
  rate: 2500,
  tenure_months: 12,
  activated_at: "2025-12-02T05:00:00Z",
  created_by: "user-1",
  metadata: {
    keep_me: "yes",
    lapse_decisions: [{ decision: "more_time" }, { decision: "paid" }],
    partner_renewal: { term_start: "2026-12-01", term_end: "2027-11-30", new_rate: 2625 },
  },
};

const params = {
  term: { start: "2026-12-01", end: "2027-11-30" },
  months: 12,
  rate: 2625,
  statementId: null,
  performedBy: null,
  now: "2026-12-01T04:00:00Z",
};

describe("successorCaseRow", () => {
  it("starts the next term live with its own dates and rate", () => {
    const row = successorCaseRow(previous, params);
    expect(row.status).toBe("active");
    expect(row.start_date).toBe("2026-12-01");
    expect(row.end_date).toBe("2027-11-30");
    expect(row.rate).toBe(2625);
    expect(row.parent_case_id).toBe("case-1");
    expect(row.case_number).toBeUndefined();
  });

  it("leaves the previous term's lapse decisions and partner confirmation behind", () => {
    const meta = successorCaseRow(previous, params).metadata as Record<string, unknown>;
    expect(meta.lapse_decisions).toBeUndefined();
    expect(meta.partner_renewal).toBeUndefined();
    expect(meta.keep_me).toBe("yes");
    expect(meta.renewed_from_case_id).toBe("case-1");
    expect(meta.renewal_billing_statement_id).toBeNull();
  });

  it("keeps the original activation time when asked (partner billing prorates by it)", () => {
    expect(successorCaseRow(previous, { ...params, activatedAt: "2025-12-02T05:00:00Z" }).activated_at).toBe("2025-12-02T05:00:00Z");
    expect(successorCaseRow(previous, params).activated_at).toBe("2026-12-01T04:00:00Z");
  });
});
