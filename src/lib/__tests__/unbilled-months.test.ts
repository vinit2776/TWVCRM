import { describe, it, expect } from "vitest";
import { unbilledMonths, type RentCoverage } from "../billing-months";

/**
 * unbilledMonths reports months a contract should already have been billed rent
 * for but wasn't. It replaces the contract-activation billing hook, which used
 * to raise a legacy `combined` statement anchored on the ACTIVATION date and, in
 * doing so, skipped every month between the contract's own first billing month
 * and the month after activation.
 *
 * Fixtures below mirror real production shapes found while auditing that bug.
 */
const TODAY = "2026-08-17";

const rent = (prepaidYear: number, prepaidMonth: number, start: string, end: string): RentCoverage => ({
  statement_type: "rent",
  period_start: start,
  period_end: end,
  prepaid_month: prepaidMonth,
  prepaid_year: prepaidYear,
  voided_at: null,
});

const combined = (prepaidYear: number, prepaidMonth: number, start: string, end: string): RentCoverage => ({
  statement_type: "combined",
  period_start: start,
  period_end: end,
  prepaid_month: prepaidMonth,
  prepaid_year: prepaidYear,
  voided_at: null,
});

describe("unbilledMonths", () => {
  it("a fully billed contract reports nothing", () => {
    expect(unbilledMonths({
      startDate: "2026-06-01",
      endDate: "2027-05-31",
      createdAt: "2026-05-02T10:00:00Z",
      today: TODAY,
      statements: [
        rent(2026, 6, "2026-06-01", "2026-06-30"),
        rent(2026, 7, "2026-07-01", "2026-07-31"),
        rent(2026, 8, "2026-08-01", "2026-08-31"),
      ],
    })).toEqual([]);
  });

  it("catches the activation-hook gap: July pro-rata billed, then a September draft, August lost", () => {
    // TWV-C-0117's exact shape — started 18 Jul, activated late, and the hook
    // produced a combined draft for prepaid Sep. August was billed by nobody.
    const missing = unbilledMonths({
      startDate: "2026-07-18",
      endDate: "2027-06-17",
      createdAt: "2026-07-21T10:00:00Z",
      today: TODAY,
      statements: [
        rent(2026, 7, "2026-07-18", "2026-07-31"),      // pro-rata for the partial start month
        combined(2026, 9, "2026-08-01", "2026-08-31"),  // hook's draft, prepaid September
      ],
    });
    expect(missing).toEqual([{ year: 2026, month: 8 }]);
  });

  it("does not blame a contract for months before its row existed", () => {
    // A contract created 30 June cannot appear in the run that billed June —
    // that run executed at the end of May. Without this floor every contract
    // predating the CRM's billing rollout reads as months in arrears.
    expect(unbilledMonths({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      createdAt: "2026-06-30T10:00:00Z",
      today: TODAY,
      statements: [
        rent(2026, 7, "2026-07-01", "2026-07-31"),
        rent(2026, 8, "2026-08-01", "2026-08-31"),
      ],
    })).toEqual([]);
  });

  it("does not report next month — it isn't late yet", () => {
    // September is billed by the run at the end of August, which hasn't run.
    const missing = unbilledMonths({
      startDate: "2026-08-01",
      endDate: "2027-07-31",
      createdAt: "2026-06-01T10:00:00Z",
      today: TODAY,
      statements: [rent(2026, 8, "2026-08-01", "2026-08-31")],
    });
    expect(missing).toEqual([]);
  });

  it("stops at the contract's end date", () => {
    // Ends 30 Sep, so only Aug is chargeable-and-late; Sep isn't due yet.
    expect(unbilledMonths({
      startDate: "2026-05-19",
      endDate: "2026-09-30",
      createdAt: "2026-05-21T10:00:00Z",
      today: TODAY,
      statements: [rent(2026, 6, "2026-06-01", "2026-06-30"), rent(2026, 7, "2026-07-01", "2026-07-31")],
    })).toEqual([{ year: 2026, month: 8 }]);
  });

  it("an advance-cycle statement covers every month of its span", () => {
    // One quarterly statement for Jun–Aug leaves nothing outstanding.
    expect(unbilledMonths({
      startDate: "2026-06-01",
      endDate: "2027-05-31",
      createdAt: "2026-05-01T10:00:00Z",
      today: TODAY,
      statements: [rent(2026, 6, "2026-06-01", "2026-08-31")],
    })).toEqual([]);
  });

  it("an advance-cycle statement does not cover months before the cycle starts", () => {
    // Same quarterly statement, but the contract was billable from May — the
    // span covers Jun–Aug and May is still outstanding.
    expect(unbilledMonths({
      startDate: "2026-05-01",
      endDate: "2027-04-30",
      createdAt: "2026-04-01T10:00:00Z",
      today: TODAY,
      statements: [rent(2026, 6, "2026-06-01", "2026-08-31")],
    })).toEqual([{ year: 2026, month: 5 }]);
  });

  it("a voided statement does not count as billed", () => {
    expect(unbilledMonths({
      startDate: "2026-07-01",
      endDate: "2027-06-30",
      createdAt: "2026-05-01T10:00:00Z",
      today: TODAY,
      statements: [
        { ...rent(2026, 7, "2026-07-01", "2026-07-31"), voided_at: "2026-07-05T00:00:00Z" },
        rent(2026, 8, "2026-08-01", "2026-08-31"),
      ],
    })).toEqual([{ year: 2026, month: 7 }]);
  });

  it("usage and other statement types never count as rent", () => {
    // TWV-C-0099 had electricity statements for Jun and Jul but no rent.
    const missing = unbilledMonths({
      startDate: "2026-05-01",
      endDate: "2027-04-30",
      createdAt: "2026-05-02T10:00:00Z",
      today: TODAY,
      statements: [
        { statement_type: "electricity", period_start: "2026-06-01", period_end: "2026-06-30", prepaid_month: null, prepaid_year: null },
        { statement_type: "usage", period_start: "2026-07-01", period_end: "2026-07-31", prepaid_month: null, prepaid_year: null },
        rent(2026, 8, "2026-08-01", "2026-08-31"),
      ],
    });
    expect(missing).toEqual([{ year: 2026, month: 6 }, { year: 2026, month: 7 }]);
  });

  it("a legacy combined row with no prepaid stamp bills the month AFTER its period", () => {
    expect(unbilledMonths({
      startDate: "2026-06-01",
      endDate: "2027-05-31",
      createdAt: "2026-05-01T10:00:00Z",
      today: TODAY,
      statements: [
        { statement_type: "combined", period_start: "2026-05-01", period_end: "2026-05-31", prepaid_month: null, prepaid_year: null },
        rent(2026, 7, "2026-07-01", "2026-07-31"),
        rent(2026, 8, "2026-08-01", "2026-08-31"),
      ],
    })).toEqual([]);
  });

  it("a brand-new contract with nothing due yet reports nothing", () => {
    expect(unbilledMonths({
      startDate: "2026-09-01",
      endDate: "2027-08-31",
      createdAt: "2026-08-15T10:00:00Z",
      today: TODAY,
      statements: [],
    })).toEqual([]);
  });
});

/**
 * Renewal chains. A renewal's opening months are routinely billed on the
 * PARENT: while the parent is still `renewal_in_progress` and the renewal has
 * not been activated, the parent is the only billable contract, so the run
 * charges it at the renewal's rate for days past its own end_date.
 *
 * Fixtures are the real TWV-C-0031 -> TWV-C-0101 chain. The parent's term ended
 * 28 Jul 2026; the renewal started 29 Jul but was not activated until 17 Aug,
 * and the 3 Aug run billed August (Rs 35,457, paid, GST issued) on the parent.
 * Judged on its own statements the renewal reads as owing August — it does not.
 */
const PARENT = "parent-uuid";
const RENEWAL = "renewal-uuid";

describe("unbilledMonths across a renewal chain", () => {
  const renewalArgs = {
    startDate: "2026-07-29",
    endDate: "2027-06-28",
    createdAt: "2026-07-07T12:05:05Z",
    today: TODAY,
    contractId: RENEWAL,
  };

  it("counts a parent statement explicitly tagged to this renewal", () => {
    expect(unbilledMonths({
      ...renewalArgs,
      statements: [
        { ...rent(2026, 7, "2026-07-29", "2026-07-31"), contract_id: RENEWAL },
        { ...rent(2026, 8, "2026-08-01", "2026-08-31"), contract_id: PARENT,
          billed_on_behalf_of_contract_id: RENEWAL },
      ],
    })).toEqual([]);
  });

  it("counts an untagged parent statement for a period after the renewal began", () => {
    // The 8 statements already in production predate the tag. A parent cannot
    // legitimately bill itself past its own term, so that rent was the renewal's.
    expect(unbilledMonths({
      ...renewalArgs,
      statements: [
        { ...rent(2026, 7, "2026-07-29", "2026-07-31"), contract_id: RENEWAL },
        { ...rent(2026, 8, "2026-08-01", "2026-08-31"), contract_id: PARENT },
      ],
    })).toEqual([]);
  });

  it("does NOT let the parent's own pre-renewal months mask a real gap", () => {
    // The parent's July (1–28 Jul, its own term) says nothing about August.
    expect(unbilledMonths({
      ...renewalArgs,
      statements: [
        { ...rent(2026, 7, "2026-07-01", "2026-07-28"), contract_id: PARENT },
        { ...rent(2026, 7, "2026-07-29", "2026-07-31"), contract_id: RENEWAL },
      ],
    })).toEqual([{ year: 2026, month: 8 }]);
  });

  it("does not count a statement attributed to a different contract", () => {
    expect(unbilledMonths({
      ...renewalArgs,
      statements: [
        { ...rent(2026, 8, "2026-08-01", "2026-08-31"), contract_id: PARENT,
          billed_on_behalf_of_contract_id: "some-other-contract" },
      ],
    })).toEqual([{ year: 2026, month: 8 }]);
  });

  it("without a contractId the caller's statements are taken at face value", () => {
    // Back-compat: existing callers pass one contract's statements and no id.
    expect(unbilledMonths({
      startDate: "2026-07-29",
      endDate: "2027-06-28",
      createdAt: "2026-07-07T12:05:05Z",
      today: TODAY,
      statements: [rent(2026, 8, "2026-08-01", "2026-08-31")],
    })).toEqual([]);
  });
});
