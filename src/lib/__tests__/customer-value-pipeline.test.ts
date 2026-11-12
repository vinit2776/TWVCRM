import { describe, it, expect } from "vitest";
import { buildMonthlyRows, monthEndsBetween, type CustomerRaw, type RawStatement } from "@/lib/customer-value/monthly-metrics";
import { diffMonths, type JourneyContractRow } from "@/lib/customer-value/journey";
import type { MoneyPaymentRow } from "@/lib/customer-value/money";
import { scoreCustomer } from "@/lib/customer-value/scoring-overall";

/**
 * The builder and the scorer, end to end, the way the backfill will run them:
 * for each month end, build the figures as known then, and score them. This is
 * the contract between the two modules.
 */

const contract: JourneyContractRow = {
  id: "c1",
  contract_number: "TWV-C-1",
  status: "active",
  start_date: "2026-01-01",
  end_date: "2027-12-31",
  activated_at: "2026-01-01T04:00:00Z",
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
};

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

/** One rent invoice a month, due on the 7th of the following month, paid a little later each time. */
function drifting(): CustomerRaw {
  const statements: RawStatement[] = [];
  const payments: MoneyPaymentRow[] = [];
  MONTHS.forEach((ym, i) => {
    const [y, m] = ym.split("-").map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const due = `${nextMonth}-07`;
    const id = `s-${ym}`;
    statements.push({
      id,
      period_start: `${ym}-01`,
      subtotal: 50000,
      total_amount: 59000,
      status: "finalized",
      due_date: due,
      finalized_at: `${ym}-25T06:00:00Z`,
    });
    // On time at first, then 2 more days late with every month.
    const lateBy = Math.max(0, (i - 2) * 2);
    const paid = new Date(Date.UTC(Number(due.slice(0, 4)), Number(due.slice(5, 7)) - 1, Number(due.slice(8, 10)) + lateBy)).toISOString().slice(0, 10);
    payments.push({ billing_statement_id: id, amount: 59000, tds_amount: 0, payment_date: paid, created_at: `${paid}T06:00:00Z` });
  });
  return {
    contracts: [contract],
    statements,
    payments,
    reminders: [],
    concessions: [],
    bookings: [],
    tickets: [],
    billingQueries: [],
    door: null,
  };
}

function scoreAsOf(raw: CustomerRaw, asOf: string) {
  const rows = buildMonthlyRows(raw, asOf);
  return scoreCustomer(
    { rows, tenureMonths: diffMonths(contract.start_date, asOf), centerRentPerSeat: 5000 },
    `${asOf.slice(0, 7)}-01`
  );
}

describe("builder into scorer, month by month", () => {
  const raw = drifting();
  const asOfDates = monthEndsBetween("2026-04-01", "2026-10-31");
  const scores = asOfDates.map((d) => ({ asOf: d, score: scoreAsOf(raw, d) }));

  it("grades a customer once they have three months of history and not before", () => {
    expect(scoreAsOf(raw, "2026-02-28").status).toBe("not_enough_data");
    expect(scoreAsOf(raw, "2026-04-30").status).toBe("graded");
  });

  it("shows the Payment score falling as the customer pays later and later", () => {
    const payment = scores.map((s) => s.score.pillars.payment.score as number);
    expect(payment[0]).toBeGreaterThan(payment[payment.length - 1]);
    // Never improves while the payments keep slipping.
    for (let i = 1; i < payment.length; i++) {
      expect(payment[i]).toBeLessThanOrEqual(payment[i - 1] + 1e-9);
    }
  });

  it("lets the overall score and tier follow", () => {
    const first = scores[0].score;
    const last = scores[scores.length - 1].score;
    expect(first.overall as number).toBeGreaterThan(last.overall as number);
  });

  it("scores a past month the same whether or not later history exists", () => {
    const truncated: CustomerRaw = {
      ...raw,
      statements: raw.statements.filter((s) => s.period_start <= "2026-05-31"),
      payments: raw.payments.filter((p) => p.billing_statement_id <= "s-2026-05" && (p.payment_date ?? "") <= "2026-06-30"),
    };
    const asOf = "2026-06-30";
    const withAll = scoreAsOf(raw, asOf);
    const withLess = scoreAsOf(truncated, asOf);
    // The truncated copy only drops invoices from after the as-of date, so the two must agree.
    expect(withAll.overall).toBe(withLess.overall);
    expect(withAll.pillars.payment.score).toBe(withLess.pillars.payment.score);
  });
});
