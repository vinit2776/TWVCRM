import { describe, it, expect } from "vitest";
import { withProrationBreakdown } from "@/lib/billing-pdf-utils";
import { buildProrataLineItems } from "@/lib/prorata-correction";
import { buildSegmentedRentLineItems } from "@/lib/billing";

describe("withProrationBreakdown", () => {
  it("states overall rent, the exact dates counted and the working when dates are stored", () => {
    const out = withProrationBreakdown("Pro-Rata Workspace Fee (Aug 20–31)", {
      monthly_rate: 11576, days_used: 12, days_in_month: 31, amount: 4481,
      period_start: "2026-08-20", period_end: "2026-08-31",
    });
    expect(out.split("\n")).toEqual([
      "Pro-Rata Workspace Fee (Aug 20–31)",
      "Monthly rent: Rs. 11,576",
      "Pro-rata: 12 of 31 days (20 Aug 2026 to 31 Aug 2026, both dates included)",
      "Rs. 11,576 × 12 ÷ 31 = Rs. 4,481",
    ]);
  });

  it("keeps the original sub-line for older items without dates", () => {
    expect(withProrationBreakdown("Monthly rent | Aug26", { monthly_rate: 5513, days_used: 19, days_in_month: 31 }))
      .toBe("Monthly rent | Aug26\nMonthly Rate: Rs. 5,513 | Days: 19");
  });

  it("leaves a full month untouched", () => {
    expect(withProrationBreakdown("Monthly rent | Aug26", { amount: 100 })).toBe("Monthly rent | Aug26");
  });

  it("omits the working when it would not reproduce the amount", () => {
    const out = withProrationBreakdown("Monthly rent | Aug26", {
      monthly_rate: 10000, days_used: 10, days_in_month: 30, amount: 4000,
      period_start: "2026-08-01", period_end: "2026-08-10",
    });
    expect(out.split("\n")).toHaveLength(3);
  });
});

describe("new pro-rata lines carry the dates", () => {
  it("first-month fee line stores the overall rent and its dates", () => {
    const [group] = buildProrataLineItems({ startDate: "2026-08-20", prorataSubtotal: 4481, monthlySubtotal: 11576, fixedShare: 0 });
    expect(group.items[0]).toMatchObject({ monthly_rate: 11576, days_used: 12, days_in_month: 31, period_start: "2026-08-20", period_end: "2026-08-31" });
  });

  it("monthly rent line shows overall rent (not per seat) with the dates", () => {
    const items = buildSegmentedRentLineItems(
      [{ start: "2026-08-01", end: "2026-08-19", days: 19, rate: 11026, amount: 6758 }],
      2, [], "Kamala Arcade", "Aug26", 31,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qty: 2, amount: 6758, monthly_rate: 11026, days_used: 19, period_start: "2026-08-01", period_end: "2026-08-19" });
  });
});

describe("full month", () => {
  it("states the overall rent and the month's dates, with no pro-rata wording", () => {
    const out = withProrationBreakdown("Monthly rent | Location: Kamala Arcade | 2 seats | Sep26", {
      monthly_rate: 11026, days_used: 30, days_in_month: 30, amount: 11026,
      period_start: "2026-09-01", period_end: "2026-09-30",
    });
    expect(out.split("\n")).toEqual([
      "Monthly rent | Location: Kamala Arcade | 2 seats | Sep26",
      "Monthly rent: Rs. 11,026 (full month, 1 Sep 2026 to 30 Sep 2026)",
    ]);
  });

  it("monthly rent builder stores overall rent and dates for an untouched month", () => {
    const items = buildSegmentedRentLineItems(
      [{ start: "2026-09-01", end: "2026-09-30", days: 30, rate: 11026, amount: 11026 }],
      2, [], "Kamala Arcade", "Sep26", 30,
    );
    expect(items[0]).toMatchObject({ amount: 11026, monthly_rate: 11026, days_used: 30, days_in_month: 30, period_start: "2026-09-01", period_end: "2026-09-30" });
  });
});
