import { describe, it, expect } from "vitest";
import { cycleMonthWindows, computeRenewalSplitRentSegments } from "../billing";
import { computeGstAndRounding } from "../gst-math";

/**
 * End-to-end arithmetic for an advance-billed cycle, exercised the way
 * generateRentProformas drives it: one window per calendar month, each priced
 * on its own days-in-month denominator, months outside the contract's term
 * pricing to zero.
 *
 * The fixture is a real shape we hit in production — a quarterly contract whose
 * term ends partway through the quarter, so the "quarterly" invoice must cover
 * only the months the contract is actually live for.
 */
const CID = "contract-under-test";
const NO_PHASES = new Map();

/** Prices a whole cycle the way the generator does, returning per-month totals. */
function priceCycle(opts: {
  startYmd: string;
  endYmd: string;
  monthlySubtotal: number;
  cycleStartMonth: number;
  cycleStartYear: number;
  cycleMonths: number;
}) {
  return cycleMonthWindows(opts.cycleStartMonth, opts.cycleStartYear, opts.cycleMonths).map((w) => {
    const split = computeRenewalSplitRentSegments(
      CID,
      opts.startYmd,
      opts.endYmd,
      opts.monthlySubtotal,
      opts.monthlySubtotal,
      opts.startYmd,
      18,
      undefined,
      NO_PHASES,
      w.first,
      w.last,
      w.days
    );
    return { month: w.month, year: w.year, amount: split.amount };
  });
}

describe("advance-cycle rent pricing", () => {
  it("a full quarter bills three whole months, not one", () => {
    // The bug this replaces: quarterly acted as a timing gate only, so a
    // quarterly contract was invoiced ONE month's rent per quarter.
    const months = priceCycle({
      startYmd: "2026-01-01",
      endYmd: "2027-12-31",
      monthlySubtotal: 65000,
      cycleStartMonth: 9,
      cycleStartYear: 2026,
      cycleMonths: 3,
    });
    expect(months.map((m) => m.amount)).toEqual([65000, 65000, 65000]);
    expect(months.reduce((s, m) => s + m.amount, 0)).toBe(195000);
  });

  it("a contract ending mid-quarter bills only the months it is live for", () => {
    // Quarterly contract, term ends 30 Sep. The Sep–Nov cycle must produce a
    // September-only invoice — never rent for Oct and Nov, which fall entirely
    // outside the contract.
    const months = priceCycle({
      startYmd: "2026-05-19",
      endYmd: "2026-09-30",
      monthlySubtotal: 65000,
      cycleStartMonth: 9,
      cycleStartYear: 2026,
      cycleMonths: 3,
    });
    expect(months).toEqual([
      { month: 9, year: 2026, amount: 65000 },
      { month: 10, year: 2026, amount: 0 },
      { month: 11, year: 2026, amount: 0 },
    ]);

    // Only the priced months land on the statement, so the period closes at
    // the contract's own end rather than running to the end of the quarter.
    const billed = months.filter((m) => m.amount > 0);
    expect(billed).toHaveLength(1);

    const subtotal = billed.reduce((s, m) => s + m.amount, 0);
    const gst = computeGstAndRounding(subtotal, 18);
    expect(subtotal).toBe(65000);
    expect(gst.cgst).toBe(5850);
    expect(gst.sgst).toBe(5850);
    expect(gst.totalAmount).toBe(76700);
  });

  it("a term ending mid-month prorates that month against its own day count", () => {
    // Ends 15 Oct: September whole, October 15/31, November nil.
    const months = priceCycle({
      startYmd: "2026-05-19",
      endYmd: "2026-10-15",
      monthlySubtotal: 62000,
      cycleStartMonth: 9,
      cycleStartYear: 2026,
      cycleMonths: 3,
    });
    expect(months[0].amount).toBe(62000);
    expect(months[1].amount).toBe(Math.round((62000 / 31) * 15));
    expect(months[2].amount).toBe(0);
  });

  it("prorates the opening month when a cycle starts before the contract does", () => {
    // Contract starts 19 Sep inside the cycle's first month: 12 of 30 days.
    const months = priceCycle({
      startYmd: "2026-09-19",
      endYmd: "2027-09-18",
      monthlySubtotal: 30000,
      cycleStartMonth: 9,
      cycleStartYear: 2026,
      cycleMonths: 3,
    });
    expect(months[0].amount).toBe(Math.round((30000 / 30) * 12));
    expect(months[1].amount).toBe(30000);
    expect(months[2].amount).toBe(30000);
  });

  it("each month uses its own day count as the proration denominator", () => {
    // February must not be prorated against a 31-day month.
    const months = priceCycle({
      startYmd: "2028-02-15",
      endYmd: "2028-12-31",
      monthlySubtotal: 28000,
      cycleStartMonth: 2,
      cycleStartYear: 2028,
      cycleMonths: 2,
    });
    // 15–29 Feb 2028 = 15 of 29 days.
    expect(months[0].amount).toBe(Math.round((28000 / 29) * 15));
    expect(months[1].amount).toBe(28000);
  });

  it("a monthly contract's single window is unchanged by any of this", () => {
    const months = priceCycle({
      startYmd: "2026-01-01",
      endYmd: "2027-12-31",
      monthlySubtotal: 41000,
      cycleStartMonth: 9,
      cycleStartYear: 2026,
      cycleMonths: 1,
    });
    expect(months).toEqual([{ month: 9, year: 2026, amount: 41000 }]);
  });
});
