import { describe, it, expect } from "vitest";
import { unbilledMonths, backfillableRentMonths, type RentCoverage } from "../billing-months";

/**
 * backfillableRentMonths decides which missed months a contract page may offer
 * to raise one at a time. Fixture mirrors TWV-C-0070 → TWV-C-0148: renewed in
 * September while its own term still ran to Oct 31, renewal starting Nov 1 —
 * October was never billed, and once the parent read `renewed` nothing on its
 * page could raise it.
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

const parent = {
  startDate: "2025-11-01",
  endDate: "2026-10-31",
  createdAt: "2026-05-20T10:00:00Z",
  today: "2026-10-05",
  // Billed June–September; October never raised.
  statements: [rent(2026, 6), rent(2026, 7), rent(2026, 8), rent(2026, 9)],
};

describe("backfillableRentMonths", () => {
  it("offers the renewed parent's unbilled remaining tenure (Oct, own end_date Oct 31)", () => {
    const missed = unbilledMonths({ ...parent, contractStatus: "renewed" });
    expect(missed).toEqual([{ year: 2026, month: 10 }]);

    expect(backfillableRentMonths({
      missed, billingCycle: "monthly", contractStatus: "renewed",
      endDate: parent.endDate, renewedAt: "2026-09-18T07:30:00Z",
    })).toEqual([{ year: 2026, month: 10 }]);
  });

  it("never offers a month past the renewed parent's own end_date (the renewal bills those)", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 10 }, { year: 2026, month: 11 }],
      billingCycle: "monthly", contractStatus: "renewed",
      endDate: "2026-10-31", renewedAt: "2026-09-18T07:30:00Z",
    })).toEqual([{ year: 2026, month: 10 }]);
  });

  it("does not offer a renewed parent's gaps from before the renewal was activated", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 7 }, { year: 2026, month: 10 }],
      billingCycle: "monthly", contractStatus: "renewed",
      endDate: "2026-10-31", renewedAt: "2026-09-18T07:30:00Z",
    })).toEqual([{ year: 2026, month: 10 }]);
  });

  it("offers nothing for a renewed parent with no renewed_at", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 10 }],
      billingCycle: "monthly", contractStatus: "renewed",
      endDate: "2026-10-31", renewedAt: null,
    })).toEqual([]);
  });

  it("keeps renewal_in_progress behaviour: only months after the own end_date", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 9 }, { year: 2026, month: 10 }, { year: 2026, month: 11 }],
      billingCycle: "monthly", contractStatus: "renewal_in_progress", endDate: "2026-09-30",
    })).toEqual([{ year: 2026, month: 10 }, { year: 2026, month: 11 }]);
  });

  it("never offers in-term gaps on an ordinary active contract", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 8 }],
      billingCycle: "monthly", contractStatus: "active", endDate: "2027-03-31",
    })).toEqual([]);
  });

  it("is monthly-only", () => {
    expect(backfillableRentMonths({
      missed: [{ year: 2026, month: 10 }],
      billingCycle: "quarterly", contractStatus: "renewed",
      endDate: "2026-10-31", renewedAt: "2026-09-18T07:30:00Z",
    })).toEqual([]);
  });
});
