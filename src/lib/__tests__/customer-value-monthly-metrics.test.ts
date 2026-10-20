import { describe, it, expect } from "vitest";
import {
  asOfForMonth,
  buildMonthlyRows,
  daysInMonth,
  monthEnd,
  monthEndsBetween,
  monthRange,
  monthStart,
  type CustomerRaw,
  type RawStatement,
} from "@/lib/customer-value/monthly-metrics";
import type { JourneyContractRow } from "@/lib/customer-value/journey";
import type { MoneyPaymentRow } from "@/lib/customer-value/money";

function contract(over: Partial<JourneyContractRow> & { id: string }): JourneyContractRow {
  return {
    contract_number: `TWV-C-${over.id}`,
    status: "active",
    start_date: "2026-04-01",
    end_date: "2026-12-31",
    activated_at: "2026-04-01T04:00:00Z",
    terminated_at: null,
    seats: 10,
    subtotal: 50000,
    escalation_percentage: 10,
    escalation_waived: false,
    escalation_approval_status: null,
    parent_contract_id: null,
    renewal_sequence: 1,
    days_extended: 0,
    phase_start_date: null,
    renewal_declined: false,
    renewal_agreed_note: null,
    rate_phases: [],
    ...over,
  };
}

function statement(id: string, over: Partial<RawStatement> = {}): RawStatement {
  return {
    id,
    period_start: "2026-08-01",
    subtotal: 50000,
    total_amount: 59000,
    status: "finalized",
    due_date: "2026-09-07",
    finalized_at: "2026-08-25T06:00:00Z",
    ...over,
  };
}

function payment(statementId: string, date: string, amount = 59000): MoneyPaymentRow {
  return { billing_statement_id: statementId, amount, tds_amount: 0, payment_date: date, created_at: `${date}T06:00:00Z` };
}

const EMPTY: CustomerRaw = {
  contracts: [contract({ id: "1" })],
  statements: [],
  payments: [],
  reminders: [],
  concessions: [],
  bookings: [],
  tickets: [],
  billingQueries: [],
  door: null,
};

const raw = (over: Partial<CustomerRaw>): CustomerRaw => ({ ...EMPTY, ...over });
const rowOf = (rows: ReturnType<typeof buildMonthlyRows>, month: string) => {
  const r = rows.find((x) => x.month === month);
  if (!r) throw new Error(`no row for ${month}`);
  return r;
};

describe("month helpers", () => {
  it("finds the first and last day and the length of a month", () => {
    expect(monthStart("2026-10-17")).toBe("2026-10-01");
    expect(monthEnd("2026-10-17")).toBe("2026-10-31");
    expect(monthEnd("2026-02-03")).toBe("2026-02-28");
    expect(monthEnd("2028-02-03")).toBe("2028-02-29");
    expect(daysInMonth("2026-04-10")).toBe(30);
  });
  it("lists months across a year boundary", () => {
    expect(monthRange("2025-11-15", "2026-02-02")).toEqual(["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]);
  });
  it("is empty when the end is before the start", () => {
    expect(monthRange("2026-05-01", "2026-03-01")).toEqual([]);
  });
  it("steps a backfill through month ends, finishing on the given date", () => {
    expect(monthEndsBetween("2026-08-10", "2026-10-17")).toEqual(["2026-08-31", "2026-09-30", "2026-10-17"]);
    expect(asOfForMonth("2026-09-01", "2026-10-17")).toBe("2026-09-30");
    expect(asOfForMonth("2026-10-01", "2026-10-17")).toBe("2026-10-17");
  });
});

describe("buildMonthlyRows: coverage and seats", () => {
  it("returns nothing for a customer with no contract that ran and no invoice", () => {
    const withdrawn = contract({ id: "w", status: "terminated", activated_at: null });
    expect(buildMonthlyRows(raw({ contracts: [withdrawn] }), "2026-10-17")).toEqual([]);
  });

  it("starts at the first contract's month and runs to the as-of month", () => {
    const rows = buildMonthlyRows(EMPTY, "2026-10-17");
    expect(rows.map((r) => r.month)).toEqual([
      "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01",
    ]);
  });

  it("reports seats and rent per seat for a contract in force the whole month", () => {
    const r = rowOf(buildMonthlyRows(EMPTY, "2026-10-17"), "2026-08-01");
    expect(r.seats_paid).toBe(10);
    expect(r.rent_per_seat).toBe(5000);
  });

  it("weights seats and rent by days when a contract changes mid-month", () => {
    // June has 30 days: 10 seats at 50,000 for 15 days, then 14 seats at 70,000 for 15 days.
    const a = contract({ id: "a", start_date: "2026-04-01", end_date: "2026-06-15", status: "renewed" });
    const b = contract({ id: "b", start_date: "2026-06-16", end_date: "2026-12-31", seats: 14, subtotal: 70000, parent_contract_id: "a" });
    const r = rowOf(buildMonthlyRows(raw({ contracts: [a, b] }), "2026-10-17"), "2026-06-01");
    expect(r.seats_paid).toBeCloseTo(12, 10); // 10 x 0.5 + 14 x 0.5
    expect(r.rent_per_seat).toBeCloseTo(5000, 6); // (25,000 + 35,000) / 12
  });

  it("has no seats before the first contract started or after the last one ended", () => {
    const early = contract({ id: "e", start_date: "2026-06-10", end_date: "2026-07-20" });
    const rows = buildMonthlyRows(raw({ contracts: [early] }), "2026-09-30");
    expect(rowOf(rows, "2026-08-01").seats_paid).toBeNull();
    expect(rowOf(rows, "2026-08-01").rent_per_seat).toBeNull();
    expect(rowOf(rows, "2026-07-01").seats_paid).toBeCloseTo((10 * 20) / 31, 10);
  });

  it("marks only the unfinished month as partial", () => {
    const rows = buildMonthlyRows(EMPTY, "2026-10-17");
    expect(rowOf(rows, "2026-10-01").data_flags.partial_month).toBe(true);
    expect(rowOf(rows, "2026-09-01").data_flags.partial_month).toBe(false);
    expect(rowOf(buildMonthlyRows(EMPTY, "2026-10-31"), "2026-10-01").data_flags.partial_month).toBe(false);
  });
});

describe("buildMonthlyRows: invoices", () => {
  it("counts revenue by period for issued invoices only", () => {
    const rows = buildMonthlyRows(
      raw({
        statements: [
          statement("a"),
          statement("draft", { status: "draft", subtotal: 99999 }),
          statement("void", { status: "voided", subtotal: 88888 }),
          statement("gone", { status: "discarded", subtotal: 77777 }),
        ],
      }),
      "2026-10-17"
    );
    expect(rowOf(rows, "2026-08-01").revenue_ex_gst).toBe(50000);
  });

  it("ignores an invoice that was not issued yet as of the date", () => {
    const rows = buildMonthlyRows(raw({ statements: [statement("a", { finalized_at: "2026-09-20T06:00:00Z" })] }), "2026-09-10");
    expect(rowOf(rows, "2026-08-01").revenue_ex_gst).toBe(0);
  });

  it("attributes timing to the month the invoice fell due, and measures days late", () => {
    const rows = buildMonthlyRows(
      raw({ statements: [statement("a")], payments: [payment("a", "2026-09-17")] }),
      "2026-10-01"
    );
    const sep = rowOf(rows, "2026-09-01");
    expect(sep).toMatchObject({ invoiced_count: 1, measured_count: 1, on_time_count: 0, avg_days_late: 10 });
    expect(rowOf(rows, "2026-08-01").invoiced_count).toBe(0);
  });

  it("counts an early or on-time payment as on time, and averages across invoices", () => {
    const rows = buildMonthlyRows(
      raw({
        statements: [statement("a"), statement("b", { period_start: "2026-08-01", due_date: "2026-09-20" })],
        payments: [payment("a", "2026-09-07"), payment("b", "2026-09-30")],
      }),
      "2026-10-01"
    );
    const sep = rowOf(rows, "2026-09-01");
    expect(sep).toMatchObject({ invoiced_count: 2, measured_count: 2, on_time_count: 1 });
    expect(sep.avg_days_late).toBe(5); // (0 + 10) / 2
  });

  it("does not know about a payment that had not happened yet (replay)", () => {
    const data = raw({ statements: [statement("a")], payments: [payment("a", "2026-09-17")] });
    const early = rowOf(buildMonthlyRows(data, "2026-09-10"), "2026-09-01");
    expect(early.measured_count).toBe(0);
    expect(early.avg_days_late).toBeNull();
    // Unpaid and three days past its 7 September due date as of 10 September.
    expect(early.overdue_amount).toBe(59000);
    expect(early.max_days_overdue).toBe(3);

    const later = rowOf(buildMonthlyRows(data, "2026-09-30"), "2026-09-01");
    expect(later.measured_count).toBe(1);
    expect(later.overdue_amount).toBe(0);
  });

  it("judges overdue at each month's end, across invoices from any month", () => {
    const rows = buildMonthlyRows(
      raw({ statements: [statement("a", { period_start: "2026-07-01", due_date: "2026-08-07" })] }),
      "2026-10-31"
    );
    expect(rowOf(rows, "2026-08-01")).toMatchObject({ overdue_amount: 59000, max_days_overdue: 24 }); // 7 to 31 Aug
    expect(rowOf(rows, "2026-10-01")).toMatchObject({ overdue_amount: 59000, max_days_overdue: 85 }); // 7 Aug to 31 Oct
    expect(rowOf(rows, "2026-07-01").overdue_amount).toBe(0); // not yet due
  });

  it("settles on cash plus TDS, so a TDS-short payment is not overdue", () => {
    const rows = buildMonthlyRows(
      raw({
        statements: [statement("a")],
        payments: [{ billing_statement_id: "a", amount: 53100, tds_amount: 5900, payment_date: "2026-09-07", created_at: "2026-09-07T06:00:00Z" }],
      }),
      "2026-10-31"
    );
    expect(rowOf(rows, "2026-09-01")).toMatchObject({ measured_count: 1, on_time_count: 1 });
    expect(rowOf(rows, "2026-10-01").overdue_amount).toBe(0);
  });

  it("keeps invoices with no due date out of timing and says how many there were", () => {
    const rows = buildMonthlyRows(
      raw({ statements: [statement("a", { due_date: null }), statement("b", { due_date: null })], payments: [payment("a", "2026-09-01")] }),
      "2026-10-01"
    );
    const aug = rowOf(rows, "2026-08-01"); // no due date, so they belong to their period month
    expect(aug).toMatchObject({ invoiced_count: 2, measured_count: 0, avg_days_late: null });
    expect(aug.data_flags.invoices_without_due_date).toBe(2);
  });

  it("counts dated reminders in their month, skips failed sends, and ignores later ones", () => {
    const rows = buildMonthlyRows(
      raw({
        reminders: [
          { billing_statement_id: "a", sent_at: "2026-09-10T06:00:00Z", status: "sent" },
          { billing_statement_id: "a", sent_at: "2026-09-12T06:00:00Z", status: "failed" },
          { billing_statement_id: "a", sent_at: "2026-10-05T06:00:00Z", status: "sent" },
        ],
      }),
      "2026-09-30"
    );
    expect(rowOf(rows, "2026-09-01").reminders).toBe(1);
  });

  it("counts concessions in the month they relate to, up to the as-of date", () => {
    const rows = buildMonthlyRows(
      raw({ concessions: [{ date: "2026-07-01", amount: 15000 }, { date: "2026-07-01", amount: 500 }, { date: "2026-09-01", amount: 9000 }] }),
      "2026-08-31"
    );
    expect(rowOf(rows, "2026-07-01").concessions_counted).toBe(15500);
    expect(rows.some((r) => r.month === "2026-09-01")).toBe(false);
  });
});

describe("buildMonthlyRows: door access", () => {
  const door = (events: Array<[string, string, string]>, centerActiveDays: string[], mapped = true) => ({
    events: events.map(([date, person, direction]) => ({ date, person, direction })),
    centerActiveDays,
    mapped,
  });

  it("averages distinct people present per center-open day, counting only IN swipes", () => {
    const rows = buildMonthlyRows(
      raw({
        door: door(
          [
            ["2026-10-01", "A", "IN"],
            ["2026-10-01", "A", "IN"], // same person twice
            ["2026-10-01", "B", "IN"],
            ["2026-10-01", "B", "OUT"],
            ["2026-10-02", "A", "IN"],
            ["2026-10-02", "C", "DENIED"],
          ],
          ["2026-10-01", "2026-10-02", "2026-10-03"]
        ),
      }),
      "2026-10-17"
    );
    const oct = rowOf(rows, "2026-10-01");
    expect(oct.seats_used_avg).toBe(1); // (2 + 1 + 0) / 3
    expect(oct.data_flags.door).toBe("mapped");
  });

  it("does not count a day the customer was absent as unknown: it is a zero", () => {
    const rows = buildMonthlyRows(
      raw({ door: door([["2026-10-01", "A", "IN"]], ["2026-10-01", "2026-10-02"]) }),
      "2026-10-17"
    );
    expect(rowOf(rows, "2026-10-01").seats_used_avg).toBe(0.5);
  });

  it("reports unknown, never zero, when the customer has no door data of their own", () => {
    const rows = buildMonthlyRows(raw({ door: door([], ["2026-10-01"], false) }), "2026-10-17");
    const oct = rowOf(rows, "2026-10-01");
    expect(oct.seats_used_avg).toBeNull();
    expect(oct.data_flags.door).toBe("unmapped");
  });

  it("reports unknown when the center has no door devices", () => {
    const oct = rowOf(buildMonthlyRows(EMPTY, "2026-10-17"), "2026-10-01");
    expect(oct.seats_used_avg).toBeNull();
    expect(oct.data_flags.door).toBe("none");
  });

  it("reports unknown for a month the center recorded no activity", () => {
    const rows = buildMonthlyRows(raw({ door: door([], ["2026-10-01"]) }), "2026-10-17");
    expect(rowOf(rows, "2026-09-01").seats_used_avg).toBeNull();
  });

  it("ignores swipes after the as-of date", () => {
    const rows = buildMonthlyRows(
      raw({ door: door([["2026-10-01", "A", "IN"], ["2026-10-20", "B", "IN"], ["2026-10-20", "C", "IN"]], ["2026-10-01", "2026-10-20"]) }),
      "2026-10-10"
    );
    expect(rowOf(rows, "2026-10-01").seats_used_avg).toBe(1); // only 1 October is known
  });
});

describe("buildMonthlyRows: tickets, bookings, billing queries", () => {
  it("counts tickets by the month they were reported, with breaches, reopens and ratings", () => {
    const rows = buildMonthlyRows(
      raw({
        tickets: [
          { id: "1", reported_at: "2026-09-02T06:00:00Z", sla_breached: true, reopen_count: 0, satisfaction_rating: 2 },
          { id: "2", reported_at: "2026-09-20T06:00:00Z", sla_breached: false, reopen_count: 1, satisfaction_rating: 4 },
          { id: "3", reported_at: "2026-09-25T06:00:00Z", sla_breached: null, reopen_count: null, satisfaction_rating: null },
          { id: "4", reported_at: "2026-10-05T06:00:00Z", sla_breached: true, reopen_count: 0, satisfaction_rating: 5 },
        ],
        ticketsUnlinkedByMonth: { "2026-09-01": 7 },
      }),
      "2026-10-17"
    );
    const sep = rowOf(rows, "2026-09-01");
    expect(sep).toMatchObject({
      tickets_linked: 3,
      tickets_sla_breached: 1,
      tickets_reopened: 1,
      satisfaction_count: 2,
      tickets_unlinked: 7,
    });
    expect(sep.satisfaction_avg).toBe(3);
    expect(rowOf(rows, "2026-08-01")).toMatchObject({ tickets_linked: 0, satisfaction_avg: null, satisfaction_count: 0 });
  });

  it("does not see a ticket reported after the as-of date", () => {
    const rows = buildMonthlyRows(
      raw({ tickets: [{ id: "1", reported_at: "2026-10-15T06:00:00Z", sla_breached: true, reopen_count: 0, satisfaction_rating: null }] }),
      "2026-10-10"
    );
    expect(rowOf(rows, "2026-10-01").tickets_linked).toBe(0);
  });

  it("counts bookings that happened, not cancellations or no-shows", () => {
    const rows = buildMonthlyRows(
      raw({
        bookings: [
          { booking_date: "2026-09-03", status: "confirmed" },
          { booking_date: "2026-09-04", status: "completed" },
          { booking_date: "2026-09-05", status: "cancelled" },
          { booking_date: "2026-09-06", status: "no_show" },
          { booking_date: "2026-10-20", status: "confirmed" },
        ],
      }),
      "2026-10-10"
    );
    expect(rowOf(rows, "2026-09-01").bookings).toBe(2);
    expect(rowOf(rows, "2026-10-01").bookings).toBe(0); // 20 October is after the as-of date
  });

  it("counts billing queries by month, and reports unknown when they could not be counted", () => {
    const counted = buildMonthlyRows(
      raw({ billingQueries: [{ created_at: "2026-09-01T06:00:00Z" }, { created_at: "2026-09-18T06:00:00Z" }] }),
      "2026-10-17"
    );
    expect(rowOf(counted, "2026-09-01").billing_queries).toBe(2);
    expect(rowOf(counted, "2026-09-01").data_flags.billing_queries_available).toBe(true);

    const unavailable = buildMonthlyRows(raw({ billingQueries: null }), "2026-10-17");
    expect(rowOf(unavailable, "2026-09-01").billing_queries).toBeNull();
    expect(rowOf(unavailable, "2026-09-01").data_flags.billing_queries_available).toBe(false);
  });
});

describe("buildMonthlyRows: replay", () => {
  it("builds the same rows as of a past date whatever happened afterwards", () => {
    const base = raw({
      statements: [statement("a")],
      payments: [payment("a", "2026-09-17")],
      tickets: [{ id: "1", reported_at: "2026-08-12T06:00:00Z", sla_breached: false, reopen_count: 0, satisfaction_rating: 4 }],
    });
    const withFuture = raw({
      ...base,
      statements: [...base.statements, statement("late", { period_start: "2026-10-01", due_date: "2026-11-07", finalized_at: "2026-10-25T06:00:00Z" })],
      payments: [...base.payments, payment("late", "2026-11-20")],
      reminders: [{ billing_statement_id: "late", sent_at: "2026-11-01T06:00:00Z", status: "sent" }],
      tickets: [...base.tickets, { id: "2", reported_at: "2026-10-20T06:00:00Z", sla_breached: true, reopen_count: 2, satisfaction_rating: 1 }],
      concessions: [{ date: "2026-10-01", amount: 12345 }],
      bookings: [{ booking_date: "2026-10-22", status: "confirmed" }],
    });
    expect(buildMonthlyRows(withFuture, "2026-09-30")).toEqual(buildMonthlyRows(base, "2026-09-30"));
  });
});
