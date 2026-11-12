import { describe, it, expect } from "vitest";
import {
  evaluateRenewalProrataGate,
  prorataStatementDispatched,
  startMonthCoveredByParentBilling,
} from "../renewal-prorata";

const base = {
  isRenewal: true,
  prorataStatus: "pending",
  startDate: "2026-10-15",
  statement: null,
  parentBilledRows: [],
};

describe("evaluateRenewalProrataGate", () => {
  it("blocks a mid-month renewal with nothing sent", () => {
    expect(evaluateRenewalProrataGate(base)).toEqual({ blocking: true, reason: "unsent" });
  });

  it("does not block a non-renewal or a 1st-of-month renewal", () => {
    expect(evaluateRenewalProrataGate({ ...base, isRenewal: false }).blocking).toBe(false);
    expect(evaluateRenewalProrataGate({ ...base, prorataStatus: "not_applicable" }).blocking).toBe(false);
  });

  it("does not block once paid or waived", () => {
    expect(evaluateRenewalProrataGate({ ...base, prorataStatus: "paid" }).reason).toBe("paid");
    expect(evaluateRenewalProrataGate({ ...base, prorataStatus: "waived" }).reason).toBe("waived");
  });

  it("a statement that exists but was never dispatched still blocks", () => {
    const r = evaluateRenewalProrataGate({ ...base, statement: { proforma_sent_at: null, handoff_state: null } });
    expect(r.blocking).toBe(true);
  });

  it("does not block once the PI is emailed or handed to the Tally Inbox", () => {
    expect(evaluateRenewalProrataGate({ ...base, statement: { proforma_sent_at: "2026-10-13T10:00:00Z" } }).reason).toBe("sent");
    expect(evaluateRenewalProrataGate({ ...base, statement: { handoff_state: "ready_to_send" } }).reason).toBe("sent");
    expect(evaluateRenewalProrataGate({ ...base, statement: { issuance_channel: "tally" } }).reason).toBe("sent");
  });

  it("does not block when the parent already billed the start month on the renewal's behalf", () => {
    const r = evaluateRenewalProrataGate({
      ...base,
      parentBilledRows: [{ statement_type: "rent", period_start: "2026-10-01", period_end: "2026-10-31", prepaid_month: 10, prepaid_year: 2026 }],
    });
    expect(r.reason).toBe("covered_by_parent_billing");
  });
});

describe("prorataStatementDispatched", () => {
  it("is false for no statement", () => {
    expect(prorataStatementDispatched(null)).toBe(false);
  });
});

describe("startMonthCoveredByParentBilling", () => {
  const row = { statement_type: "rent", period_start: "2026-11-01", period_end: "2026-11-30", prepaid_month: 11, prepaid_year: 2026 };
  it("ignores a different month", () => {
    expect(startMonthCoveredByParentBilling("2026-10-15", [row])).toBe(false);
  });
  it("ignores voided and non-rent statements", () => {
    const cover = { statement_type: "rent", period_start: "2026-10-01", period_end: "2026-10-31", prepaid_month: 10, prepaid_year: 2026 };
    expect(startMonthCoveredByParentBilling("2026-10-15", [{ ...cover, voided_at: "2026-10-02" }])).toBe(false);
    expect(startMonthCoveredByParentBilling("2026-10-15", [{ ...cover, statement_type: "usage" }])).toBe(false);
  });
});
