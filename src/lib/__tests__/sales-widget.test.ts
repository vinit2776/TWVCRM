import { describe, it, expect } from "vitest";
import {
  classifyStatement,
  daysPastDue,
  effectiveDueDate,
  exGstAmount,
  fyDateRange,
  fyLabel,
  fyMonthKeys,
  fyStartYearOf,
  overdueBucket,
  todayIst,
  unpaidFraction,
  type SalesStatementShape,
} from "../sales-widget";

const stmt = (over: Partial<SalesStatementShape>): SalesStatementShape => ({
  statement_type: "rent",
  created_via: null,
  contract_id: "c1",
  booking_id: null,
  invoice_id: null,
  case_id: null,
  aggregator_id: null,
  subtotal: 10_000,
  total_amount: 11_800,
  tax_percentage: 18,
  fixed_amount: 10_000,
  booking_usage_amount: 0,
  ...over,
});

const sum = (parts: { amount: number }[]) => Math.round(parts.reduce((a, p) => a + p.amount, 0) * 100) / 100;

describe("financial year", () => {
  it("rolls over on 1 April", () => {
    expect(fyStartYearOf("2027-03-31")).toBe(2026);
    expect(fyStartYearOf("2027-04-01")).toBe(2027);
    expect(fyStartYearOf("2026-10-09")).toBe(2026);
  });

  it("lists April→March month keys across the year boundary", () => {
    const keys = fyMonthKeys(2026);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2026-04");
    expect(keys[8]).toBe("2026-12");
    expect(keys[9]).toBe("2027-01");
    expect(keys[11]).toBe("2027-03");
  });

  it("labels and bounds the year", () => {
    expect(fyLabel(2026)).toBe("FY 2026-27");
    expect(fyLabel(2099)).toBe("FY 2099-00");
    expect(fyDateRange(2026)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("reads today in IST, not UTC", () => {
    // 19:00 UTC on 31 Mar is already 1 April in India.
    expect(todayIst(new Date("2027-03-31T19:00:00Z"))).toBe("2027-04-01");
  });
});

describe("classifyStatement", () => {
  it("puts a rent statement in Rent", () => {
    expect(classifyStatement(stmt({}))).toEqual([{ stream: "rent", amount: 10_000 }]);
  });

  it("routes Virtual Office statement types and owners to VO", () => {
    expect(classifyStatement(stmt({ statement_type: "vo_case", contract_id: null, case_id: "k" }))[0].stream).toBe("vo");
    expect(classifyStatement(stmt({ statement_type: "vo_renewal" }))[0].stream).toBe("vo");
    expect(classifyStatement(stmt({ statement_type: "vo_aggregator_consolidated", contract_id: null, aggregator_id: "a" }))[0].stream).toBe("vo");
  });

  it("routes electricity and ad-hoc invoices", () => {
    expect(classifyStatement(stmt({ statement_type: "electricity" }))[0].stream).toBe("electricity");
    expect(classifyStatement(stmt({ statement_type: "reimbursement" }))[0].stream).toBe("adhoc");
    expect(classifyStatement(stmt({ statement_type: null, contract_id: null, invoice_id: "i" }))[0].stream).toBe("adhoc");
    expect(classifyStatement(stmt({ created_via: "adhoc_invoice" }))[0].stream).toBe("adhoc");
  });

  it("treats a stand-alone booking statement as Bookings", () => {
    const parts = classifyStatement(stmt({ statement_type: null, contract_id: null, booking_id: "b" }));
    expect(parts).toEqual([{ stream: "bookings", amount: 10_000 }]);
  });

  it("carves bookings out of a usage statement and keeps the rest as Usage", () => {
    const parts = classifyStatement(stmt({ statement_type: "usage", fixed_amount: 0, subtotal: 10_000, booking_usage_amount: 3_500 }));
    expect(parts).toEqual([
      { stream: "bookings", amount: 3_500 },
      { stream: "usage", amount: 6_500 },
    ]);
  });

  it("splits a legacy combined statement into rent, bookings and usage", () => {
    const parts = classifyStatement(stmt({ statement_type: "combined", subtotal: 10_000, fixed_amount: 7_000, booking_usage_amount: 1_000 }));
    expect(parts).toEqual([
      { stream: "rent", amount: 7_000 },
      { stream: "bookings", amount: 1_000 },
      { stream: "usage", amount: 2_000 },
    ]);
  });

  it("never lets the parts exceed the statement value", () => {
    // booking_usage_amount larger than the whole statement must be capped.
    const parts = classifyStatement(stmt({ statement_type: "usage", fixed_amount: 0, subtotal: 1_000, booking_usage_amount: 5_000 }));
    expect(sum(parts)).toBe(1_000);
  });

  it("derives ex-GST from the total when subtotal is missing", () => {
    expect(exGstAmount({ subtotal: null, total_amount: 11_800, tax_percentage: 18 })).toBeCloseTo(10_000, 5);
    expect(classifyStatement(stmt({ subtotal: null }))[0].amount).toBeCloseTo(10_000, 2);
  });

  it("returns nothing for a zero-value statement", () => {
    expect(classifyStatement(stmt({ subtotal: 0, total_amount: 0 }))).toEqual([]);
  });
});

describe("unpaidFraction", () => {
  it("is 1 when nothing is paid and 0 when settled", () => {
    expect(unpaidFraction(11_800, 0)).toBe(1);
    expect(unpaidFraction(11_800, 11_800)).toBe(0);
  });

  it("scales with a part payment", () => {
    expect(unpaidFraction(11_800, 5_900)).toBeCloseTo(0.5, 5);
  });

  it("settles against the whole-rupee total, so a paise-short payment is still paid", () => {
    expect(unpaidFraction(11_800.4, 11_800)).toBe(0);
  });

  it("treats a written-off balance as closed", () => {
    expect(unpaidFraction(10_000, 6_000, 4_000)).toBe(0);
    expect(unpaidFraction(10_000, 6_000, 1_000)).toBeCloseTo(0.3, 5);
  });

  it("is 0 for a zero-value statement", () => {
    expect(unpaidFraction(0, 0)).toBe(0);
  });
});

describe("overdue by due date", () => {
  it("prefers the early-GST due date over the statement due date", () => {
    expect(effectiveDueDate({ gst_invoice_due_date: "2026-09-10", due_date: "2026-09-20" })).toBe("2026-09-10");
    expect(effectiveDueDate({ gst_invoice_due_date: null, due_date: "2026-09-20" })).toBe("2026-09-20");
    expect(effectiveDueDate({ gst_invoice_due_date: null, due_date: null })).toBeNull();
  });

  it("counts whole days past the due date", () => {
    expect(daysPastDue("2026-10-01", "2026-10-09")).toBe(8);
    expect(daysPastDue("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysPastDue("2026-10-15", "2026-10-09")).toBe(-6);
    expect(daysPastDue(null, "2026-10-09")).toBeNull();
  });

  it("buckets by days past due, and a due date today is not yet overdue", () => {
    expect(overdueBucket(null)).toBe("no_due_date");
    expect(overdueBucket(-3)).toBe("not_due");
    expect(overdueBucket(0)).toBe("not_due");
    expect(overdueBucket(1)).toBe("d_1_30");
    expect(overdueBucket(30)).toBe("d_1_30");
    expect(overdueBucket(31)).toBe("d_31_60");
    expect(overdueBucket(60)).toBe("d_31_60");
    expect(overdueBucket(61)).toBe("d_60_plus");
  });
});
