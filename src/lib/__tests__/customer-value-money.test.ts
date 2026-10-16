import { describe, it, expect } from "vitest";
import {
  buildMoney,
  isIssued,
  rentInMonth,
  settledOn,
  type MoneyConcessionInput,
  type MoneyInput,
  type MoneyPaymentRow,
  type MoneyStatementRow,
} from "@/lib/customer-value/money";
import type { JourneyRentStep } from "@/lib/customer-value/journey";

const TODAY = "2026-10-16";

function stmt(over: Partial<MoneyStatementRow> & { id: string }): MoneyStatementRow {
  return {
    statement_number: `BS-${over.id}`,
    gst_invoice_number: null,
    statement_type: "rent",
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    subtotal: 50000,
    tax_amount: 9000,
    total_amount: 59000,
    status: "finalized",
    due_date: "2026-09-07",
    reminder_count: 0,
    ...over,
  };
}

function pay(statementId: string, over: Partial<MoneyPaymentRow> = {}): MoneyPaymentRow {
  return {
    billing_statement_id: statementId,
    amount: 59000,
    tds_amount: 0,
    payment_date: "2026-09-07",
    created_at: "2026-09-07T05:00:00Z",
    ...over,
  };
}

const NO_CONCESSIONS: MoneyConcessionInput = {
  rentWaivers: [],
  moratoriums: [],
  bookingWaivers: [],
  refunds: [],
  creditNotes: [],
  contractNumbers: {},
};

const STEPS: JourneyRentStep[] = [
  { contractId: "c1", contractNumber: "TWV-C-1", from: "2026-01-01", to: "2026-12-31", monthlyRent: 50000, seats: 10, perSeat: 5000 },
];

function input(over: Partial<MoneyInput>): MoneyInput {
  return { statements: [], payments: [], concessions: NO_CONCESSIONS, rentSteps: STEPS, today: TODAY, ...over };
}

describe("isIssued", () => {
  it("counts only finalized and exported statements", () => {
    expect(isIssued("finalized")).toBe(true);
    expect(isIssued("exported")).toBe(true);
  });
  it("excludes drafts, voided and discarded statements", () => {
    expect(isIssued("draft")).toBe(false);
    expect(isIssued("voided")).toBe(false);
    expect(isIssued("discarded")).toBe(false);
  });
  it("leaves out a status it does not know", () => {
    expect(isIssued("something_new")).toBe(false);
  });
});

describe("settledOn", () => {
  it("returns the date of the payment that completed settlement", () => {
    const payments = [
      pay("a", { amount: 30000, payment_date: "2026-09-05", created_at: "2026-09-05T05:00:00Z" }),
      pay("a", { amount: 29000, payment_date: "2026-09-20", created_at: "2026-09-20T05:00:00Z" }),
    ];
    expect(settledOn(payments, 59000)).toBe("2026-09-20");
  });
  it("counts TDS toward settlement", () => {
    const payments = [pay("a", { amount: 53100, tds_amount: 5900, payment_date: "2026-09-10" })];
    expect(settledOn(payments, 59000)).toBe("2026-09-10");
  });
  it("tolerates paise by settling against the whole-rupee total", () => {
    expect(settledOn([pay("a", { amount: 59000, payment_date: "2026-09-10" })], 59000.4)).toBe("2026-09-10");
  });
  it("is null when the invoice never settled", () => {
    expect(settledOn([pay("a", { amount: 1000 })], 59000)).toBeNull();
  });
  it("is null for a zero-value invoice", () => {
    expect(settledOn([], 0)).toBeNull();
  });
});

describe("rentInMonth", () => {
  it("finds the contract's rent for the month", () => {
    expect(rentInMonth(STEPS, "c1", "2026-08-01")).toBe(50000);
  });
  it("is null when no step covers the month", () => {
    expect(rentInMonth(STEPS, "c1", "2027-03-01")).toBeNull();
    expect(rentInMonth(STEPS, "other", "2026-08-01")).toBeNull();
  });
});

describe("buildMoney: lifetime and timing", () => {
  it("ignores drafts, voided and discarded statements everywhere", () => {
    const m = buildMoney(
      input({
        statements: [
          stmt({ id: "a" }),
          stmt({ id: "d", status: "draft", subtotal: 99999, total_amount: 99999 }),
          stmt({ id: "v", status: "voided", subtotal: 77777, total_amount: 77777 }),
          stmt({ id: "x", status: "discarded", subtotal: 55555, total_amount: 55555 }),
        ],
        payments: [pay("a"), pay("v", { amount: 77777 })],
      })
    );
    expect(m.lifetime.issuedCount).toBe(1);
    expect(m.lifetime.invoicedExGst).toBe(50000);
    expect(m.lifetime.invoicedInclGst).toBe(59000);
    expect(m.lifetime.cashReceived).toBe(59000);
    expect(m.invoices).toHaveLength(1);
  });

  it("splits cash from TDS and settles on both", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a" })],
        payments: [pay("a", { amount: 53100, tds_amount: 5900 })],
      })
    );
    expect(m.lifetime.cashReceived).toBe(53100);
    expect(m.lifetime.tdsDeducted).toBe(5900);
    expect(m.lifetime.outstanding).toBe(0);
    expect(m.invoices[0].paymentStatus).toBe("paid");
  });

  it("measures days late against the due date, early as negative", () => {
    const m = buildMoney(
      input({
        statements: [
          stmt({ id: "a", due_date: "2026-09-07" }),
          stmt({ id: "b", period_start: "2026-07-01", due_date: "2026-08-07" }),
        ],
        payments: [
          pay("a", { payment_date: "2026-09-17" }), // 10 days late
          pay("b", { payment_date: "2026-08-05" }), // 2 days early
        ],
      })
    );
    const byRef = Object.fromEntries(m.invoices.map((i) => [i.reference, i.daysLate]));
    expect(byRef["BS-a"]).toBe(10);
    expect(byRef["BS-b"]).toBe(-2);
    expect(m.timing.measuredCount).toBe(2);
    expect(m.timing.onTimeCount).toBe(1);
    expect(m.timing.onTimePct).toBe(50);
    expect(m.timing.avgDaysLate).toBe(4);
    expect(m.timing.worstDaysLate).toBe(10);
  });

  it("leaves invoices without a due date out of the timing figures", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", due_date: null }), stmt({ id: "b", period_start: "2026-07-01", due_date: "2026-08-07" })],
        payments: [pay("a"), pay("b", { payment_date: "2026-08-07" })],
      })
    );
    expect(m.timing.issuedCount).toBe(2);
    expect(m.timing.withDueDateCount).toBe(1);
    expect(m.timing.measuredCount).toBe(1);
    expect(m.invoices.find((i) => i.reference === "BS-a")?.daysLate).toBeNull();
  });

  it("reports nothing measurable as null, not zero", () => {
    const m = buildMoney(input({ statements: [stmt({ id: "a", due_date: null })], payments: [pay("a")] }));
    expect(m.timing.onTimePct).toBeNull();
    expect(m.timing.avgDaysLate).toBeNull();
    expect(m.timing.worstDaysLate).toBeNull();
  });

  it("flags unpaid invoices past their due date", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", due_date: "2026-10-06" }), stmt({ id: "b", period_start: "2026-10-01", due_date: "2026-10-30" })],
      })
    );
    expect(m.timing.overdueNow).toMatchObject({ count: 1, amount: 59000, maxDays: 10 });
    expect(m.lifetime.outstanding).toBe(118000);
  });

  it("treats a part-paid invoice as overdue for the remaining balance", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", due_date: "2026-10-06" })],
        payments: [pay("a", { amount: 20000 })],
      })
    );
    expect(m.invoices[0].paymentStatus).toBe("partially_paid");
    expect(m.invoices[0].balance).toBe(39000);
    expect(m.timing.overdueNow.amount).toBe(39000);
  });

  it("shows an overpayment as a customer credit without hiding other balances", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a" }), stmt({ id: "b", period_start: "2026-07-01", due_date: "2026-08-07" })],
        payments: [pay("a", { amount: 69000 })], // 10,000 over on a
      })
    );
    expect(m.lifetime.overpaid).toBe(10000);
    expect(m.lifetime.overpaidCount).toBe(1);
    expect(m.invoices.find((i) => i.reference === "BS-a")?.balance).toBe(0);
    expect(m.lifetime.outstanding).toBe(59000); // b is still owed in full
  });

  it("counts reminders", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", reminder_count: 2 }), stmt({ id: "b", period_start: "2026-07-01", reminder_count: 0 })],
      })
    );
    expect(m.timing.remindedCount).toBe(1);
    expect(m.timing.totalReminders).toBe(2);
  });

  it("averages revenue over the months since the first invoice, inclusive", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", period_start: "2026-08-01" }), stmt({ id: "b", period_start: "2026-09-01" })],
      })
    );
    expect(m.lifetime.firstInvoiceDate).toBe("2026-08-01");
    expect(m.lifetime.monthsSpan).toBe(3); // Aug, Sep, Oct
    expect(m.lifetime.avgMonthlyExGst).toBeCloseTo(100000 / 3, 5);
  });

  it("lists invoices newest period first", () => {
    const m = buildMoney(
      input({
        statements: [stmt({ id: "a", period_start: "2026-06-01" }), stmt({ id: "b", period_start: "2026-09-01" })],
      })
    );
    expect(m.invoices.map((i) => i.reference)).toEqual(["BS-b", "BS-a"]);
  });

  it("is empty and safe with no statements", () => {
    const m = buildMoney(input({}));
    expect(m.lifetime.issuedCount).toBe(0);
    expect(m.lifetime.firstInvoiceDate).toBeNull();
    expect(m.lifetime.avgMonthlyExGst).toBe(0);
    expect(m.invoices).toEqual([]);
  });

  it("prefers the GST invoice number as the reference", () => {
    const m = buildMoney(input({ statements: [stmt({ id: "a", gst_invoice_number: "TWV/INV/26-27/0004" })] }));
    expect(m.invoices[0].reference).toBe("TWV/INV/26-27/0004");
  });
});

describe("buildMoney: concessions", () => {
  it("lists a rent waiver as an unbilled month, priced but never counted as a concession", () => {
    const m = buildMoney(
      input({
        concessions: {
          ...NO_CONCESSIONS,
          contractNumbers: { c1: "TWV-C-1" },
          rentWaivers: [{ contract_id: "c1", waived_month: "2026-08-01", reason: "AC outage", revoked_at: null }],
        },
      })
    );
    expect(m.concessions.entries[0]).toMatchObject({ kind: "rent_waiver", amount: 50000, counted: false });
    expect(m.concessions.totals.rent_waiver).toBe(0);
    expect(m.concessions.totals.unbilledRent).toBe(50000);
    expect(m.concessions.totals.all).toBe(0);
  });

  it("skips revoked waivers entirely", () => {
    const m = buildMoney(
      input({
        concessions: {
          ...NO_CONCESSIONS,
          rentWaivers: [{ contract_id: "c1", waived_month: "2026-08-01", reason: null, revoked_at: "2026-09-01T00:00:00Z" }],
        },
      })
    );
    expect(m.concessions.entries).toHaveLength(0);
  });

  it("counts only approved moratoriums that were not billed anyway", () => {
    const m = buildMoney(
      input({
        concessions: {
          ...NO_CONCESSIONS,
          moratoriums: [
            { contract_id: "c1", moratorium_month: "2026-03-01", reason: null, status: "approved", overridden_at: null },
            { contract_id: "c1", moratorium_month: "2026-04-01", reason: null, status: "approved", overridden_at: "2026-04-02T00:00:00Z" },
            { contract_id: "c1", moratorium_month: "2026-05-01", reason: null, status: "pending", overridden_at: null },
            { contract_id: "c1", moratorium_month: "2026-06-01", reason: null, status: "rejected", overridden_at: null },
          ],
        },
      })
    );
    expect(m.concessions.entries).toHaveLength(3); // rejected is dropped
    expect(m.concessions.entries.filter((e) => e.counted)).toHaveLength(1);
    expect(m.concessions.totals.moratorium).toBe(50000);
    expect(m.concessions.entries.find((e) => e.date === "2026-04-01")?.note).toBe("Billed anyway after approval");
  });

  it("counts approved booking waivers, processed refunds and live credit notes only", () => {
    const m = buildMoney(
      input({
        concessions: {
          ...NO_CONCESSIONS,
          bookingWaivers: [
            { waiver_type: "overtime", waiver_amount: 800, status: "approved", approved_at: "2026-09-01T06:00:00Z", created_at: "2026-09-01T05:00:00Z", note: null },
            { waiver_type: "extension", waiver_amount: 500, status: "pending", approved_at: null, created_at: "2026-09-02T05:00:00Z", note: null },
            { waiver_type: "other", waiver_amount: 999, status: "denied", approved_at: null, created_at: "2026-09-03T05:00:00Z", note: null },
          ],
          refunds: [
            { amount_requested: 2000, status: "processed", processed_at: "2026-09-10T06:00:00Z", requested_at: "2026-09-05T05:00:00Z", reason: null },
            { amount_requested: 1500, status: "approved", processed_at: null, requested_at: "2026-09-11T05:00:00Z", reason: null },
          ],
          creditNotes: [
            { credit_note_amount: 3000, credit_note_date: "2026-09-12", credit_note_number: "CN-1", reason: "Rate correction", superseded_by: null },
            { credit_note_amount: 4000, credit_note_date: "2026-09-13", credit_note_number: "CN-0", reason: null, superseded_by: "x" },
          ],
        },
      })
    );
    expect(m.concessions.totals.booking_waiver).toBe(800);
    expect(m.concessions.totals.refund).toBe(2000);
    expect(m.concessions.totals.credit_note).toBe(3000);
    expect(m.concessions.totals.all).toBe(5800);
    // 2 waivers (denied one dropped) + 2 refunds + 1 credit note (superseded one dropped)
    expect(m.concessions.entries).toHaveLength(5);
  });

  it("lists entries newest first and leaves unpriced ones out of the total", () => {
    const m = buildMoney(
      input({
        concessions: {
          ...NO_CONCESSIONS,
          rentWaivers: [
            { contract_id: "c1", waived_month: "2026-02-01", reason: null, revoked_at: null },
            { contract_id: "zzz", waived_month: "2026-09-01", reason: null, revoked_at: null },
          ],
        },
      })
    );
    expect(m.concessions.entries.map((e) => e.date)).toEqual(["2026-09-01", "2026-02-01"]);
    expect(m.concessions.entries[0].amount).toBeNull();
    expect(m.concessions.totals.unbilledRent).toBe(50000);
    expect(m.concessions.totals.all).toBe(0);
  });
});
