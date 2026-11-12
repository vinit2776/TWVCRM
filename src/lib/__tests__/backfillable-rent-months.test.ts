import { describe, it, expect } from "vitest";
import { unbilledMonths, backfillableRentMonths, type RentCoverage } from "../billing-months";

/**
 * backfillableRentMonths decides which missed rent months can be raised one at
 * a time ("Bill this month" on the contract page, "Send invoice" on Billing →
 * Unbilled). Fixtures mirror October 2026: the month-end run for October was
 * missed, and once October started "Bill next cycle" targeted November, so
 * nothing could raise October.
 */
const rent = (y: number, m: number): RentCoverage => {
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return {
    statement_type: "rent",
    period_start: `${y}-${mm}-01`,
    period_end: `${y}-${mm}-${last}`,
    prepaid_month: m,
    prepaid_year: y,
    voided_at: null,
  };
};

const TODAY = "2026-10-05";
const oct = { year: 2026, month: 10 };

describe("backfillableRentMonths", () => {
  it("offers an active contract's missed current month (October)", () => {
    const missed = unbilledMonths({
      startDate: "2026-03-01", endDate: "2027-02-28", createdAt: "2026-02-20T10:00:00Z", today: TODAY,
      statements: [rent(2026, 6), rent(2026, 7), rent(2026, 8), rent(2026, 9)],
      contractStatus: "active",
    });
    expect(missed).toContainEqual(oct);
    expect(backfillableRentMonths({ missed, billingCycle: "monthly", contractStatus: "active", endDate: "2027-02-28" }))
      .toEqual(missed.filter((m) => m.year * 12 + m.month >= 2026 * 12 + 6));
  });

  it("never offers months before June 2026 (rent then was billed outside the CRM)", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 4 }, { year: 2026, month: 5 }, { year: 2026, month: 6 }, oct],
      billingCycle: "monthly", contractStatus: "active", endDate: "2027-02-28",
    })).toEqual([{ year: 2026, month: 6 }, oct]);
  });

  it("offers a renewed parent's remaining tenure, never past its own end_date (TWV-C-0070 → 0148)", () => {
    const missed = unbilledMonths({
      startDate: "2025-11-01", endDate: "2026-10-31", createdAt: "2026-05-20T10:00:00Z", today: TODAY,
      statements: [rent(2026, 6), rent(2026, 7), rent(2026, 8), rent(2026, 9)],
      contractStatus: "renewed",
    });
    expect(missed).toEqual([oct]);
    expect(backfillableRentMonths({ missed, billingCycle: "monthly", contractStatus: "renewed", endDate: "2026-10-31" }))
      .toEqual([oct]);
    expect(backfillableRentMonths({
      missed: [oct, { year: 2026, month: 11 }], billingCycle: "monthly", contractStatus: "renewed", endDate: "2026-10-31",
    })).toEqual([oct]);
  });

  it("renewal_in_progress: offers months after its own end_date too", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 9 }, oct, { year: 2026, month: 11 }],
      billingCycle: "monthly", contractStatus: "renewal_in_progress", endDate: "2026-09-30",
    })).toEqual([{ year: 2026, month: 9 }, oct, { year: 2026, month: 11 }]);
  });

  it("offers nothing for statuses the generator won't bill", () => {
    for (const status of ["expired", "terminated", "draft", "accepted"]) {
      expect(backfillableRentMonths({ missed: [oct], billingCycle: "monthly", contractStatus: status, endDate: "2026-12-31" }))
        .toEqual([]);
    }
  });

  it("is monthly-only", () => {
    expect(backfillableRentMonths({ missed: [oct], billingCycle: "quarterly", contractStatus: "active", endDate: "2027-03-31" }))
      .toEqual([]);
  });
});

describe("unbilledMonths with waivers", () => {
  const base = {
    startDate: "2026-03-01", endDate: "2027-02-28", createdAt: "2026-02-20T10:00:00Z", today: TODAY,
    statements: [rent(2026, 6), rent(2026, 7), rent(2026, 8)],
    contractStatus: "active",
  };

  it("treats a waived month as handled", () => {
    expect(unbilledMonths(base)).toContainEqual({ year: 2026, month: 9 });
    const withWaiver = unbilledMonths({ ...base, waivedMonths: ["2026-09-01"] });
    expect(withWaiver).not.toContainEqual({ year: 2026, month: 9 });
    expect(withWaiver).toContainEqual(oct);
  });
});
