import { describe, it, expect } from "vitest";
import { buildStory, type StoryFacts } from "@/lib/customer-value/scoring-story";
import { scoreCustomer, type CustomerScore, type CustomerScoreInput } from "@/lib/customer-value/scoring-overall";
import type { MonthlyMetrics } from "@/lib/customer-value/scoring-pillars";

const AS_OF = "2026-10-01";

function monthsBefore(n: number): string {
  const [y, m] = AS_OF.split("-").map(Number);
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
}

function row(monthsAgo: number, over: Partial<MonthlyMetrics> = {}): MonthlyMetrics {
  return {
    month: monthsBefore(monthsAgo),
    revenue_ex_gst: 50000,
    invoiced_count: 1,
    avg_days_late: 0,
    measured_count: 1,
    on_time_count: 1,
    overdue_amount: 0,
    max_days_overdue: 0,
    reminders: 0,
    concessions_counted: 0,
    seats_paid: 10,
    seats_used_avg: 9,
    rent_per_seat: 5500,
    tickets_linked: 0,
    tickets_sla_breached: 0,
    tickets_reopened: 0,
    satisfaction_avg: null,
    satisfaction_count: 0,
    bookings: 10,
    billing_queries: 0,
    ...over,
  };
}

const input = (over: Partial<CustomerScoreInput> = {}): CustomerScoreInput => ({
  rows: [0, 1, 2, 3, 4, 5].map((n) => row(n)),
  tenureMonths: 12,
  renewal: { renewed: 1, declined: 0 },
  centerRentPerSeat: 5000,
  escalations: ["accepted"],
  ...over,
});

const graded: CustomerScore = scoreCustomer(input(), AS_OF); // an A
const struggling: CustomerScore = scoreCustomer(
  input({
    rows: [0, 1, 2, 3, 4, 5].map((n) =>
      row(n, { avg_days_late: 20, on_time_count: 0, overdue_amount: 50000, max_days_overdue: 20, seats_used_avg: 3, tickets_linked: 3 })
    ),
    renewal: { renewed: 0, declined: 1 },
  }),
  AS_OF
);
const young: CustomerScore = scoreCustomer(input({ tenureMonths: 1 }), AS_OF);

const quiet: StoryFacts = {
  avgDaysLate: null,
  reminders90d: null,
  overdueInvoices: null,
  overdueTickets: null,
  seatsUsedPct: null,
  renewalInDays: null,
};

const texts = (s: ReturnType<typeof buildStory>) => s.sentences.map((x) => x.text);

describe("buildStory: sentences", () => {
  it("says nothing when there are no facts", () => {
    expect(buildStory(graded, "flat", quiet).sentences).toEqual([]);
  });

  it("describes late payment, with reminders", () => {
    const s = buildStory(graded, "flat", { ...quiet, avgDaysLate: 9.04, reminders90d: 4 });
    expect(texts(s)[0]).toBe("Pays about 9 days late, with 4 reminders in the last 90 days.");
    expect(s.sentences[0].metric).toBe("payment");
  });

  it("says a single reminder in the singular", () => {
    const s = buildStory(graded, "flat", { ...quiet, avgDaysLate: 3, reminders90d: 1 });
    expect(texts(s)[0]).toContain("1 reminder in");
    expect(texts(s)[0]).not.toContain("reminders");
  });

  it("describes early payment and on-the-day payment", () => {
    expect(texts(buildStory(graded, "flat", { ...quiet, avgDaysLate: -2.5 }))[0]).toBe("Pays about 2.5 days early.");
    expect(texts(buildStory(graded, "flat", { ...quiet, avgDaysLate: 0.4 }))[0]).toBe("Pays on or close to the due date.");
  });

  it("states open problems together", () => {
    const s = buildStory(graded, "flat", { ...quiet, overdueInvoices: { count: 2, maxDays: 22 }, overdueTickets: 1 });
    expect(texts(s)).toEqual(["2 unpaid invoices, up to 22 days overdue and 1 ticket overdue."]);
  });

  it("stays quiet about problems that are not there", () => {
    const s = buildStory(graded, "flat", { ...quiet, overdueInvoices: { count: 0, maxDays: 0 }, overdueTickets: 0 });
    expect(s.sentences).toEqual([]);
  });

  it("mentions direction only for a real move with a known previous tier", () => {
    const down = buildStory(graded, "down", { ...quiet, previous: { tier: "B", overall: 70 } });
    expect(texts(down)).toEqual(["Score is down from B to A over the last 90 days."]);
    expect(texts(buildStory(graded, "up", { ...quiet, previous: { tier: "C", overall: 50 } }))[0]).toContain("up from C");
    expect(buildStory(graded, "flat", { ...quiet, previous: { tier: "A", overall: 80 } }).sentences).toEqual([]);
    expect(buildStory(graded, "down", { ...quiet, previous: null }).sentences).toEqual([]);
    expect(buildStory(graded, null, { ...quiet, previous: { tier: "B", overall: 70 } }).sentences).toEqual([]);
  });

  it("does not claim a direction for a customer who could not be graded", () => {
    expect(buildStory(young, "down", { ...quiet, previous: { tier: "B", overall: 70 } }).sentences).toEqual([]);
  });

  it("states seat use only where door data exists", () => {
    expect(texts(buildStory(graded, "flat", { ...quiet, seatsUsedPct: 39.6 }))).toEqual(["Uses 40% of the seats they pay for."]);
    expect(buildStory(graded, "flat", quiet).sentences).toEqual([]);
  });

  it("mentions a renewal only when it is near", () => {
    expect(texts(buildStory(graded, "flat", { ...quiet, renewalInDays: 70 }))).toEqual(["Renewal is in 70 days."]);
    expect(buildStory(graded, "flat", { ...quiet, renewalInDays: 400 }).sentences).toEqual([]);
    expect(buildStory(graded, "flat", { ...quiet, renewalInDays: -5 }).sentences).toEqual([]);
  });

  it("orders sentences by priority and never exceeds five", () => {
    const s = buildStory(graded, "down", {
      avgDaysLate: 9,
      reminders90d: 4,
      overdueInvoices: { count: 1, maxDays: 10 },
      overdueTickets: 2,
      seatsUsedPct: 40,
      renewalInDays: 70,
      previous: { tier: "B", overall: 70 },
    });
    expect(s.sentences.map((x) => x.metric)).toEqual(["payment", "open_problems", "direction", "usage", "renewal"]);
    expect(s.sentences.length).toBeLessThanOrEqual(5);
  });

  it("attaches the evidence it was given to the matching sentence", () => {
    const s = buildStory(graded, "flat", {
      ...quiet,
      avgDaysLate: 9,
      overdueTickets: 1,
      evidence: { payment: ["inv-1", "inv-2"], open_problems: ["tkt-9"] },
    });
    expect(s.sentences.find((x) => x.metric === "payment")?.evidence).toEqual(["inv-1", "inv-2"]);
    expect(s.sentences.find((x) => x.metric === "open_problems")?.evidence).toEqual(["tkt-9"]);
  });

  it("gives every sentence an evidence list, empty when none was passed", () => {
    const s = buildStory(graded, "flat", { ...quiet, avgDaysLate: 9 });
    expect(s.sentences[0].evidence).toEqual([]);
  });
});

describe("buildStory: suggested action", () => {
  it("tells you to clear overdue tickets when a renewal is close", () => {
    const a = buildStory(struggling, "down", { ...quiet, overdueTickets: 2, renewalInDays: 70 }).action;
    expect(a.code).toBe("clear_tickets_before_renewal");
  });

  it("does not push tickets for a renewal that is far off", () => {
    const a = buildStory(graded, "flat", { ...quiet, overdueTickets: 2, renewalInDays: 200 }).action;
    expect(a.code).not.toBe("clear_tickets_before_renewal");
  });

  it("tells you to chase invoices overdue by two weeks or more", () => {
    expect(buildStory(graded, "flat", { ...quiet, overdueInvoices: { count: 1, maxDays: 14 } }).action.code).toBe("chase_overdue_invoices");
    expect(buildStory(graded, "flat", { ...quiet, overdueInvoices: { count: 1, maxDays: 13 } }).action.code).not.toBe("chase_overdue_invoices");
  });

  it("tells you to review seats when use is low and a renewal is near", () => {
    const a = buildStory(graded, "flat", { ...quiet, seatsUsedPct: 40, renewalInDays: 90 }).action;
    expect(a.code).toBe("review_seat_count");
    expect(buildStory(graded, "flat", { ...quiet, seatsUsedPct: 40, renewalInDays: 300 }).action.code).not.toBe("review_seat_count");
    expect(buildStory(graded, "flat", { ...quiet, seatsUsedPct: 80, renewalInDays: 90 }).action.code).not.toBe("review_seat_count");
  });

  it("puts overdue tickets ahead of overdue invoices ahead of low seat use", () => {
    const all = { ...quiet, overdueTickets: 1, overdueInvoices: { count: 1, maxDays: 30 }, seatsUsedPct: 20, renewalInDays: 30 };
    expect(buildStory(graded, "flat", all).action.code).toBe("clear_tickets_before_renewal");
    expect(buildStory(graded, "flat", { ...all, overdueTickets: 0 }).action.code).toBe("chase_overdue_invoices");
    expect(buildStory(graded, "flat", { ...all, overdueTickets: 0, overdueInvoices: null }).action.code).toBe("review_seat_count");
  });

  it("says there is not enough history for a customer who could not be graded", () => {
    expect(buildStory(young, null, quiet).action.code).toBe("not_enough_data");
  });

  it("still flags a real problem on a customer who could not be graded", () => {
    const a = buildStory(young, null, { ...quiet, overdueInvoices: { count: 1, maxDays: 30 } }).action;
    expect(a.code).toBe("chase_overdue_invoices");
  });

  it("suggests protecting a strong, stable customer with nothing open", () => {
    expect(graded.tier).toBe("A");
    expect(buildStory(graded, "flat", quiet).action.code).toBe("protect");
    expect(buildStory(graded, "up", quiet).action.code).toBe("protect");
  });

  it("does not suggest protecting a strong customer who is slipping or has open problems", () => {
    expect(buildStory(graded, "down", quiet).action.code).toBe("monitor");
    expect(buildStory(graded, "flat", { ...quiet, overdueTickets: 1 }).action.code).toBe("monitor");
  });

  it("falls back to no action for a weaker customer with nothing pressing", () => {
    expect(["C", "D"]).toContain(struggling.tier);
    expect(buildStory(struggling, "flat", quiet).action.code).toBe("monitor");
  });
});
