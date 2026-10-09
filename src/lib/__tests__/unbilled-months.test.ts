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

  it("reports the first month for a contract created in that very month", () => {
    // TWV-C-0153: started 7 Sep (pro-rata covers Sep), created 5 Oct. The
    // October run executed on 28-30 Sep, before the row existed, so October
    // is billed by nobody.
    expect(unbilledMonths({
      startDate: "2026-09-07",
      endDate: "2027-08-06",
      createdAt: "2026-10-05T10:00:00Z",
      today: "2026-10-09",
      statements: [],
    })).toEqual([{ year: 2026, month: 10 }]);
  });

  it("does not report the creation month when the first billing month was earlier", () => {
    // Entered after the fact: first full month (Aug) was already past when the
    // row was created, so only months after creation are in scope (Oct, not Aug/Sep).
    expect(unbilledMonths({
      startDate: "2026-07-26",
      endDate: "2027-07-25",
      createdAt: "2026-09-01T10:00:00Z",
      today: "2026-10-20",
      statements: [],
    })).toEqual([{ year: 2026, month: 10 }]);
  });

  it("stops at the termination month for a terminated contract", () => {
    // TWV-C-0141: terminated 19 Sep with end_date still in 2027. October rent
    // was never due.
    expect(unbilledMonths({
      startDate: "2026-09-07",
      endDate: "2027-03-06",
      createdAt: "2026-09-03T10:00:00Z",
      today: "2026-10-09",
      statements: [],
      contractStatus: "terminated",
      activatedAt: "2026-09-08T10:00:00Z",
      terminatedAt: "2026-09-19T10:00:00Z",
    })).toEqual([]);
  });

  it("still reports the termination month itself when unbilled", () => {
    expect(unbilledMonths({
      startDate: "2026-05-01",
      endDate: "2027-04-30",
      createdAt: "2026-04-01T10:00:00Z",
      today: "2026-10-09",
      statements: [rent(2026, 5, "2026-05-01", "2026-05-31"), rent(2026, 6, "2026-06-01", "2026-06-30"), rent(2026, 7, "2026-07-01", "2026-07-31")],
      contractStatus: "terminated",
      activatedAt: "2026-05-02T10:00:00Z",
      terminatedAt: "2026-08-18T10:00:00Z",
    })).toEqual([{ year: 2026, month: 8 }]);
  });

  it("a terminated contract that was never activated owes nothing", () => {
    // TWV-C-0144: withdrawn before it began.
    expect(unbilledMonths({
      startDate: "2026-09-07",
      endDate: "2027-08-06",
      createdAt: "2026-09-08T10:00:00Z",
      today: "2026-10-09",
      statements: [],
      contractStatus: "terminated",
      activatedAt: null,
      terminatedAt: "2026-09-21T10:00:00Z",
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

/**
 * Regression coverage for the renewal_in_progress window bug: unbilledMonths()
 * used to cap its check at the contract's own end_date for every status,
 * which meant a renewal stuck unactivated past its parent's term silently
 * stopped being checked for gaps the rent generator (computeRenewalSplitRentSegments
 * in billing.ts) is still supposed to be filling. Modelled on the real case —
 * Cargolux's TWV-C-0020, term ended 2026-08-14, renewal TWV-C-0123 accepted
 * but never activated, September rent never generated or flagged.
 *
 * createdAt is set to 2026-08-01 (rather than the contract's real 2025-08-15
 * start) purely so the checkable window opens right at the boundary under
 * test — August itself is already covered by augStatement, isolating whether
 * September gets flagged instead of also needing 11 months of prior coverage
 * fixtures that have nothing to do with what's being tested here.
 */
describe("unbilledMonths — renewal_in_progress window", () => {
  const augStatement: RentCoverage = {
    statement_type: "rent",
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    prepaid_month: 8,
    prepaid_year: 2026,
    voided_at: null,
  };

  it("flags September as missing for a renewal_in_progress contract whose own term lapsed in August", () => {
    const missing = unbilledMonths({
      startDate: "2025-08-15",
      endDate: "2026-08-14",
      createdAt: "2026-08-01",
      today: "2026-09-02",
      statements: [augStatement],
      contractStatus: "renewal_in_progress",
    });
    expect(missing).toEqual([{ year: 2026, month: 9 }]);
  });

  it("does NOT flag September for the same dates when status is plain active (no renewal in flight)", () => {
    const missing = unbilledMonths({
      startDate: "2025-08-15",
      endDate: "2026-08-14",
      createdAt: "2026-08-01",
      today: "2026-09-02",
      statements: [augStatement],
      contractStatus: "active",
    });
    expect(missing).toEqual([]);
  });

  it("does NOT flag September when contractStatus is omitted — falls back to the pre-fix capped behaviour", () => {
    const missing = unbilledMonths({
      startDate: "2025-08-15",
      endDate: "2026-08-14",
      createdAt: "2026-08-01",
      today: "2026-09-02",
      statements: [augStatement],
    });
    expect(missing).toEqual([]);
  });

  it("stops flagging once a September statement exists for the renewal_in_progress contract", () => {
    const missing = unbilledMonths({
      startDate: "2025-08-15",
      endDate: "2026-08-14",
      createdAt: "2026-08-01",
      today: "2026-09-02",
      statements: [
        augStatement,
        {
          statement_type: "rent",
          period_start: "2026-09-01",
          period_end: "2026-09-30",
          prepaid_month: 9,
          prepaid_year: 2026,
          voided_at: null,
        },
      ],
      contractStatus: "renewal_in_progress",
    });
    expect(missing).toEqual([]);
  });

  it("keeps accumulating missed months up through today while renewal_in_progress persists", () => {
    const missing = unbilledMonths({
      startDate: "2025-08-15",
      endDate: "2026-08-14",
      createdAt: "2026-08-01",
      today: "2026-11-05",
      statements: [augStatement],
      contractStatus: "renewal_in_progress",
    });
    expect(missing).toEqual([
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
    ]);
  });
});
