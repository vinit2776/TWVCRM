import { describe, it, expect } from "vitest";
import { summarizeBillsByMonth } from "@/lib/bills-monthly-summary";

const bill = (id: string, date: string | null, amt: number | string, status: string, approval?: string) => ({
  id, invoice_date: date, total_amount: amt, payment_status: status, approval_status: approval,
});

describe("summarizeBillsByMonth", () => {
  it("groups by invoice month, oldest first, split by payment status", () => {
    const s = summarizeBillsByMonth(
      [
        bill("a", "2026-09-04", 6420, "unpaid"),
        bill("b", "2026-09-20", "1355.80", "paid"),
        bill("c", "2026-06-02", 6028.45, "unpaid"),
        bill("d", "2026-06-10", 100.1, "partially_paid"),
      ],
      new Map(),
    );
    expect(s.months.map((m) => m.month)).toEqual(["2026-06", "2026-09"]);
    expect(s.months[1]).toMatchObject({ billCount: 2, total: 7775.8, paid: 1355.8, unpaid: 6420 });
    expect(s.months[0]).toMatchObject({ partiallyPaid: 100.1, unpaid: 6028.45 });
    expect(s.total).toBe(13904.35);
    expect(s.paid + s.partiallyPaid + s.unpaid).toBeCloseTo(s.total, 2);
  });

  it("keeps rejected bills out of paid/unpaid but in the total", () => {
    const s = summarizeBillsByMonth(
      [
        bill("a", "2026-04-02", 6420, "unpaid", "rejected"),
        bill("b", "2026-04-03", 1680, "paid", "approved"),
        bill("c", "2026-09-01", 100, "unpaid", "approved"),
      ],
      new Map(),
    );
    expect(s.months[0]).toMatchObject({ total: 8100, paid: 1680, unpaid: 0, rejected: 6420 });
    expect(s).toMatchObject({ total: 8200, paid: 1680, unpaid: 100, rejected: 6420 });
    expect(s.paid + s.partiallyPaid + s.unpaid + s.rejected).toBeCloseTo(s.total, 2);
  });

  it("counts open queries per month and bills affected", () => {
    const s = summarizeBillsByMonth(
      [bill("a", "2026-09-04", 10, "paid"), bill("b", "2026-07-04", 10, "paid"), bill("c", "2026-07-05", 10, "paid")],
      new Map([["a", 2], ["b", 1], ["zzz", 5]]),
    );
    expect(s.openQueries).toBe(3);
    expect(s.billsWithOpenQueries).toBe(2);
    expect(s.months.find((m) => m.month === "2026-07")?.openQueries).toBe(1);
  });

  it("puts bills without an invoice date in their own bucket and handles empty input", () => {
    expect(summarizeBillsByMonth([bill("a", null, 5, "unpaid")], new Map()).months[0].month).toBe("none");
    expect(summarizeBillsByMonth([], new Map())).toMatchObject({ billCount: 0, total: 0, months: [] });
  });
});
