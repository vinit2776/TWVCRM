import { describe, it, expect } from "vitest";
import {
  AUTO_RENEW_HOLD_LABELS,
  addDaysYmd,
  computeNoticeSchedule,
  evaluateAutoRenewEligibility,
  isNegotiatedEscalation,
  parseAutoRenewMode,
  parseAutoRenewTiming,
  programmedEscalation,
  subtractMonthsYmd,
  subtractNoticePeriod,
  type AutoRenewEligibilityInput,
} from "../auto-renewal";

describe("parseAutoRenewMode", () => {
  it("accepts the three known modes", () => {
    expect(parseAutoRenewMode("off")).toBe("off");
    expect(parseAutoRenewMode("dry_run")).toBe("dry_run");
    expect(parseAutoRenewMode("live")).toBe("live");
  });

  it("treats anything missing or unrecognised as a dry run, never live", () => {
    expect(parseAutoRenewMode(undefined)).toBe("dry_run");
    expect(parseAutoRenewMode(null)).toBe("dry_run");
    expect(parseAutoRenewMode("")).toBe("dry_run");
    expect(parseAutoRenewMode("LIVE")).toBe("dry_run");
    expect(parseAutoRenewMode("true")).toBe("dry_run");
  });
});

describe("parseAutoRenewTiming", () => {
  it("uses the defaults when settings are absent", () => {
    expect(parseAutoRenewTiming({})).toEqual({ draftLeadDays: 7, noticeLeadDays: 7, confirmationDays: 15 });
  });

  it("reads numeric settings and ignores junk", () => {
    expect(
      parseAutoRenewTiming({
        auto_renew_draft_lead_days: "10",
        auto_renew_notice_lead_days: "abc",
        auto_renew_confirmation_days: "-3",
      }),
    ).toEqual({ draftLeadDays: 10, noticeLeadDays: 7, confirmationDays: 15 });
  });
});

describe("programmedEscalation", () => {
  it("prefers the base agreement's figure over the rate applied to this term", () => {
    expect(programmedEscalation({ agreement_escalation_percentage: 10, escalation_percentage: 7 })).toBe(10);
  });

  it("falls back to the applied rate when no base figure is recorded", () => {
    expect(programmedEscalation({ escalation_percentage: 8 })).toBe(8);
    expect(programmedEscalation({ agreement_escalation_percentage: null, escalation_percentage: 12 })).toBe(12);
  });

  it("reads a missing or zero percentage as 10, matching what the agreement PDF prints", () => {
    expect(programmedEscalation({})).toBe(10);
    expect(programmedEscalation({ escalation_percentage: 0 })).toBe(10);
    expect(programmedEscalation({ agreement_escalation_percentage: 0, escalation_percentage: 0 })).toBe(10);
  });

  it("accepts the strings Postgres returns for NUMERIC columns", () => {
    expect(programmedEscalation({ agreement_escalation_percentage: "10.00", escalation_percentage: "7.00" })).toBe(10);
  });
});

describe("isNegotiatedEscalation", () => {
  it("flags a different rate and ignores float noise", () => {
    expect(isNegotiatedEscalation(7, 10)).toBe(true);
    expect(isNegotiatedEscalation(0, 10)).toBe(true);
    expect(isNegotiatedEscalation(10, 10)).toBe(false);
    expect(isNegotiatedEscalation(10.00001, 10)).toBe(false);
  });
});

describe("date helpers", () => {
  it("clamps month subtraction to the last day of the shorter month", () => {
    expect(subtractMonthsYmd("2027-03-31", 1)).toBe("2027-02-28");
    expect(subtractMonthsYmd("2028-03-31", 1)).toBe("2028-02-29");
    expect(subtractMonthsYmd("2026-11-30", 2)).toBe("2026-09-30");
    expect(subtractMonthsYmd("2027-01-15", 2)).toBe("2026-11-15");
  });

  it("subtracts a fractional notice period as months plus 15 days", () => {
    expect(subtractNoticePeriod("2026-11-30", 2)).toBe("2026-09-30");
    expect(subtractNoticePeriod("2026-11-30", 1)).toBe("2026-10-30");
    expect(subtractNoticePeriod("2026-11-30", 1.5)).toBe("2026-10-15");
    expect(subtractNoticePeriod("2026-11-30", 0.5)).toBe("2026-11-15");
    expect(subtractNoticePeriod("2026-11-30", 0)).toBe("2026-11-30");
  });

  it("adds and subtracts days across month ends", () => {
    expect(addDaysYmd("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDaysYmd("2026-12-01", -1)).toBe("2026-11-30");
  });
});

describe("computeNoticeSchedule (term ending 30 Nov 2026)", () => {
  const END = "2026-11-30";

  it("2-month notice period: notice 7 days before the deadline", () => {
    expect(computeNoticeSchedule(END, 2)).toEqual({
      draftOn: "2026-09-16",
      noticeOn: "2026-09-23",
      noticeDeadline: "2026-09-30",
      confirmationOn: "2026-11-15",
      pulledEarlierForSplitInvoice: false,
    });
  });

  it("1-month notice period", () => {
    expect(computeNoticeSchedule(END, 1)).toEqual({
      draftOn: "2026-10-16",
      noticeOn: "2026-10-23",
      noticeDeadline: "2026-10-30",
      confirmationOn: "2026-11-15",
      pulledEarlierForSplitInvoice: false,
    });
  });

  it("1.5-month notice period counts the half as 15 days", () => {
    expect(computeNoticeSchedule(END, 1.5)).toEqual({
      draftOn: "2026-10-01",
      noticeOn: "2026-10-08",
      noticeDeadline: "2026-10-15",
      confirmationOn: "2026-11-15",
      pulledEarlierForSplitInvoice: false,
    });
  });

  it("0-month notice period: notice 7 days before the end, no confirmation", () => {
    expect(computeNoticeSchedule(END, 0)).toEqual({
      draftOn: "2026-11-16",
      noticeOn: "2026-11-23",
      noticeDeadline: "2026-11-30",
      confirmationOn: null,
      pulledEarlierForSplitInvoice: false,
    });
  });

  it("honours custom timing settings", () => {
    const s = computeNoticeSchedule(END, 2, { draftLeadDays: 3, noticeLeadDays: 10, confirmationDays: 20 });
    expect(s.noticeOn).toBe("2026-09-20");
    expect(s.draftOn).toBe("2026-09-17");
    expect(s.confirmationOn).toBe("2026-11-10");
  });
});

describe("computeNoticeSchedule for a term ending mid-month", () => {
  it("keeps the normal date when it already precedes the month-end billing run", () => {
    // Ends 15 Nov, 1-month notice: deadline 15 Oct, notice 8 Oct, before the 27 Oct cap.
    const s = computeNoticeSchedule("2026-11-15", 1);
    expect(s.noticeOn).toBe("2026-10-08");
    expect(s.pulledEarlierForSplitInvoice).toBe(false);
  });

  it("pulls notice #1 before the previous month's billing run when it would land after it", () => {
    // Ends 15 Nov, 0 notice: normal notice 8 Nov, after the October run that bills November.
    const s = computeNoticeSchedule("2026-11-15", 0);
    expect(s.noticeOn).toBe("2026-10-27");
    expect(s.draftOn).toBe("2026-10-20");
    expect(s.pulledEarlierForSplitInvoice).toBe(true);
  });

  it("never pulls a month-end term, whose invoice has no split", () => {
    const s = computeNoticeSchedule("2026-11-30", 0);
    expect(s.pulledEarlierForSplitInvoice).toBe(false);
    expect(s.noticeOn).toBe("2026-11-23");
  });

  it("handles a term ending in the first days of a month", () => {
    // Ends 2 Dec, 0 notice: normal notice 25 Nov, after the 27 Nov cap? No: 25 < 27.
    expect(computeNoticeSchedule("2026-12-02", 0).noticeOn).toBe("2026-11-25");
    // Ends 5 Dec, 0 notice: normal notice 28 Nov, after the cap, so pulled to 27 Nov.
    const s = computeNoticeSchedule("2026-12-05", 0);
    expect(s.noticeOn).toBe("2026-11-27");
    expect(s.pulledEarlierForSplitInvoice).toBe(true);
  });
});

describe("evaluateAutoRenewEligibility", () => {
  const clean: AutoRenewEligibilityInput = {
    autoRenew: true,
    status: "active",
    renewalDeclined: false,
    hasLiveExit: false,
    overdueAmount: 0,
    hasActiveMoratorium: false,
    hasActiveRentWaiver: false,
    hasRatePhases: false,
    hasUnapprovedSpecialClause: false,
    escalationApprovalPending: false,
  };

  it("is eligible with nothing in the way", () => {
    expect(evaluateAutoRenewEligibility(clean)).toEqual({ eligible: true, holds: [] });
  });

  it("a contract with auto-renewal off is neither eligible nor held", () => {
    const r = evaluateAutoRenewEligibility({ ...clean, autoRenew: false, overdueAmount: 5000, hasLiveExit: true });
    expect(r).toEqual({ eligible: false, holds: [] });
  });

  it("stays eligible while a renewal draft is in progress", () => {
    expect(evaluateAutoRenewEligibility({ ...clean, status: "renewal_in_progress" }).eligible).toBe(true);
  });

  it.each([
    ["not_live", { status: "expired" }],
    ["renewal_declined", { renewalDeclined: true }],
    ["exit_in_progress", { hasLiveExit: true }],
    ["overdue", { overdueAmount: 24000 }],
    ["moratorium", { hasActiveMoratorium: true }],
    ["rent_waiver", { hasActiveRentWaiver: true }],
    ["rate_phases", { hasRatePhases: true }],
    ["special_clause_unapproved", { hasUnapprovedSpecialClause: true }],
    ["escalation_approval_pending", { escalationApprovalPending: true }],
  ] as const)("holds for %s", (code, patch) => {
    const r = evaluateAutoRenewEligibility({ ...clean, ...patch });
    expect(r.eligible).toBe(false);
    expect(r.holds).toEqual([{ code, label: AUTO_RENEW_HOLD_LABELS[code] }]);
  });

  it("reports every reason at once, so staff fix them in one pass", () => {
    const r = evaluateAutoRenewEligibility({ ...clean, overdueAmount: 100, hasActiveRentWaiver: true });
    expect(r.holds.map((h) => h.code)).toEqual(["overdue", "rent_waiver"]);
  });
});
