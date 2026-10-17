import { describe, it, expect } from "vitest";
import {
  scoreEngagement,
  scoreFriction,
  scorePayment,
  scoreProfitability,
  type MonthlyMetrics,
  type PillarResult,
} from "@/lib/customer-value/scoring-pillars";
import type { MetricResult } from "@/lib/customer-value/scoring-primitives";
import { DEFAULT_SCORING_SETTINGS as S } from "@/lib/customer-value/scoring-settings";

const AS_OF = "2026-10-01";

/** Month `n` months before AS_OF, as YYYY-MM-01. */
function monthsBefore(n: number): string {
  const [y, m] = AS_OF.split("-").map(Number);
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
}

/** A calm, healthy month; override only what a test cares about. */
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
    seats_used_avg: null,
    rent_per_seat: 5000,
    tickets_linked: 0,
    tickets_sla_breached: 0,
    tickets_reopened: 0,
    satisfaction_avg: null,
    satisfaction_count: 0,
    bookings: 0,
    billing_queries: 0,
    ...over,
  };
}

const sixMonths = (over: Partial<MonthlyMetrics> | ((n: number) => Partial<MonthlyMetrics>) = {}) =>
  [0, 1, 2, 3, 4, 5].map((n) => row(n, typeof over === "function" ? over(n) : over));

const metric = (r: PillarResult, key: string): MetricResult => {
  const found = r.metrics.find((m) => m.key === key);
  if (!found) throw new Error(`No metric ${key} on the ${r.pillar} pillar`);
  return found;
};

describe("scorePayment", () => {
  it("gives a customer who always pays on the day a full score", () => {
    const r = scorePayment(sixMonths(), AS_OF, S);
    expect(r.score).toBeCloseTo(100, 5);
    expect(r.confidence).toBe(1);
    expect(r.monthsUsed).toBe(6);
    expect(r.notes).toEqual([]);
  });

  it("scores a chronically late payer low", () => {
    // 15 days late and never on time = 0 on both; no overdue balance and no reminders = 100 on the other two.
    const r = scorePayment(sixMonths({ avg_days_late: 15, on_time_count: 0 }), AS_OF, S);
    // (0*40 + 0*30 + 100*20 + 100*10) / 100
    expect(r.score).toBeCloseTo(30, 5);
  });

  it("counts a bad recent month for more than the same bad month long ago", () => {
    const recentBad = scorePayment(
      sixMonths((n) => (n < 3 ? { avg_days_late: 15, on_time_count: 0 } : {})),
      AS_OF,
      S
    );
    const oldBad = scorePayment(
      sixMonths((n) => (n >= 3 ? { avg_days_late: 15, on_time_count: 0 } : {})),
      AS_OF,
      S
    );
    expect(recentBad.score as number).toBeLessThan(oldBad.score as number);
  });

  it("weights the average by how many invoices each month had", () => {
    // A month with nine invoices 15 days late and a month with one on-time invoice.
    const r = scorePayment(
      [
        row(0, { avg_days_late: 15, measured_count: 9, on_time_count: 0, invoiced_count: 9 }),
        row(1, { avg_days_late: 0, measured_count: 1, on_time_count: 1, invoiced_count: 1 }),
      ],
      AS_OF,
      S
    );
    // (15 x 1 x 9 + 0 x 0.794 x 1) / (1 x 9 + 0.794 x 1) = about 13.8, far closer to 15 than to 0.
    expect(metric(r, "avg_days_late").value as number).toBeCloseTo(13.78, 1);
  });

  it("caps the pillar when an invoice is left a month overdue, however good the average", () => {
    const rows = sixMonths();
    rows[0] = row(0, { max_days_overdue: 34, overdue_amount: 5000 });
    const r = scorePayment(rows, AS_OF, S);
    expect(r.score).toBe(30);
    expect(r.notes.join(" ")).toMatch(/34 days overdue/);
  });

  it("does not raise a low score up to the cap", () => {
    const rows = sixMonths({ avg_days_late: 15, on_time_count: 0, reminders: 1 });
    rows[0] = row(0, { avg_days_late: 15, on_time_count: 0, reminders: 1, max_days_overdue: 40, overdue_amount: 50000 });
    const r = scorePayment(rows, AS_OF, S);
    expect(r.score as number).toBeLessThanOrEqual(30);
  });

  it("has no score and no confidence when there were no invoices", () => {
    const r = scorePayment(sixMonths({ invoiced_count: 0, measured_count: 0, on_time_count: 0, avg_days_late: null }), AS_OF, S);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.metrics.every((m) => m.status === "missing")).toBe(true);
  });

  it("scores on what it can when due dates are missing, with lower confidence", () => {
    const r = scorePayment(sixMonths({ avg_days_late: null, measured_count: 0, on_time_count: 0 }), AS_OF, S);
    expect(metric(r, "avg_days_late").status).toBe("missing");
    expect(metric(r, "on_time_share").status).toBe("missing");
    // Only overdue (20) and reminders (10) could be scored, out of 100.
    expect(r.confidence).toBeCloseTo(0.3, 10);
    expect(r.score).toBeCloseTo(100, 5);
  });

  it("ignores months after asOf", () => {
    const rows = [...sixMonths(), row(-1, { avg_days_late: 40, on_time_count: 0, max_days_overdue: 60 })];
    expect(scorePayment(rows, AS_OF, S).score).toBeCloseTo(100, 5);
  });

  it("ranks by percentile when the cohort is large enough", () => {
    const cohort = { avg_days_late: [1, 2, 3, 4, 5, 6, 7, 8] };
    const r = scorePayment(sixMonths(), AS_OF, S, cohort);
    expect(metric(r, "avg_days_late")).toMatchObject({ method: "percentile", score: 100 });
  });

  it("falls back to the fixed scale when the cohort is small", () => {
    const cohort = { avg_days_late: [1, 2, 3, 4, 5, 6, 7] };
    const r = scorePayment(sixMonths(), AS_OF, S, cohort);
    expect(metric(r, "avg_days_late")).toMatchObject({ method: "fixed" });
  });
});

describe("scoreFriction", () => {
  it("gives a customer with no tickets a full score and leaves not-applicable measures out", () => {
    const r = scoreFriction(sixMonths(), AS_OF, S);
    expect(metric(r, "tickets_per_seat_quarter").score).toBe(100);
    expect(metric(r, "sla_breached_share").status).toBe("na");
    expect(metric(r, "repeat_share").status).toBe("na");
    expect(metric(r, "satisfaction_avg").status).toBe("na");
    expect(r.score).toBeCloseTo(100, 5);
    expect(r.confidence).toBe(1);
  });

  it("scores a heavy ticket load, breaches and low ratings", () => {
    const r = scoreFriction(
      sixMonths({ tickets_linked: 2, tickets_sla_breached: 1, tickets_reopened: 0, satisfaction_avg: 4, satisfaction_count: 1 }),
      AS_OF,
      S
    );
    // 2 tickets a month on 10 seats = 0.6 per seat per quarter = worst (0); half breached = worst (0);
    // none reopened = 100; satisfaction 4 = 66.67; no billing queries = 100.
    // (0*30 + 0*20 + 100*20 + 66.667*20 + 100*10) / 100
    expect(r.score).toBeCloseTo(43.333, 2);
  });

  it("does not score ticket measures when too few of the center's tickets can be tied to customers", () => {
    const r = scoreFriction(sixMonths(), AS_OF, S, {}, 0.3);
    expect(metric(r, "tickets_per_seat_quarter").status).toBe("missing");
    expect(metric(r, "sla_breached_share").status).toBe("missing");
    expect(metric(r, "repeat_share").status).toBe("missing");
    expect(r.notes.join(" ")).toMatch(/30%/);
    // Only billing queries (10) was scored, against 30 + 20 + 20 missing.
    expect(r.confidence).toBeCloseTo(10 / 80, 10);
  });

  it("trusts ticket measures at exactly the coverage threshold", () => {
    expect(metric(scoreFriction(sixMonths(), AS_OF, S, {}, 0.5), "tickets_per_seat_quarter").status).toBe("ok");
  });

  it("cannot rate tickets per seat without a seat count", () => {
    const r = scoreFriction(sixMonths({ seats_paid: null }), AS_OF, S);
    expect(metric(r, "tickets_per_seat_quarter").status).toBe("missing");
  });

  it("treats billing queries as missing when they could not be counted", () => {
    const r = scoreFriction(sixMonths({ billing_queries: null }), AS_OF, S);
    expect(metric(r, "billing_queries_per_quarter").status).toBe("missing");
  });

  it("weights satisfaction by how many ratings each month had", () => {
    // One rating of 1 this month, nine ratings of 5 last month.
    const r = scoreFriction(
      [
        row(0, { tickets_linked: 1, satisfaction_avg: 1, satisfaction_count: 1 }),
        row(1, { tickets_linked: 9, satisfaction_avg: 5, satisfaction_count: 9 }),
      ],
      AS_OF,
      S
    );
    // (1 x 1 x 1 + 0.794 x 5 x 9) / (1 x 1 + 0.794 x 9) = about 4.51, pulled toward the nine ratings.
    expect(metric(r, "satisfaction_avg").value as number).toBeCloseTo(4.51, 1);
  });

  it("has no score when there is no data in the window", () => {
    const r = scoreFriction([], AS_OF, S);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("scoreEngagement", () => {
  it("scores a customer who uses their seats, books, holds steady and renews", () => {
    const r = scoreEngagement(
      sixMonths({ seats_used_avg: 8, bookings: 10 }),
      AS_OF,
      S,
      {},
      { renewed: 1, declined: 0 }
    );
    // used 80% = 100; 10 bookings on 10 seats = 1 per seat = 100; flat seats = 60; renewed = 100.
    // (100*40 + 100*20 + 60*20 + 100*20) / 100
    expect(r.score).toBeCloseTo(92, 5);
    expect(r.confidence).toBe(1);
  });

  it("marks seats used missing and says why when there is no door data", () => {
    const r = scoreEngagement(sixMonths({ bookings: 10 }), AS_OF, S, {}, { renewed: 1, declined: 0 });
    expect(metric(r, "seats_used_ratio").status).toBe("missing");
    expect(r.notes.join(" ")).toMatch(/door-access/);
    // Scored: bookings 20, trend 20, renewal 20 = 60 of 100.
    expect(r.confidence).toBeCloseTo(0.6, 10);
  });

  it("scores a declined renewal as zero", () => {
    const r = scoreEngagement(sixMonths(), AS_OF, S, {}, { renewed: 0, declined: 1 });
    expect(metric(r, "renewal_behaviour").score).toBe(0);
  });

  it("leaves renewal out when none was due", () => {
    const r = scoreEngagement(sixMonths(), AS_OF, S, {}, { renewed: 0, declined: 0 });
    expect(metric(r, "renewal_behaviour").status).toBe("na");
    expect(metric(scoreEngagement(sixMonths(), AS_OF, S), "renewal_behaviour").status).toBe("na");
  });

  it("rewards growth and punishes shrinking across the window", () => {
    const grew = scoreEngagement([row(0, { seats_paid: 11 }), row(5, { seats_paid: 10 })], AS_OF, S);
    expect(metric(grew, "seat_trend_pct").score).toBe(100); // +10%
    const shrank = scoreEngagement([row(0, { seats_paid: 7.5 }), row(5, { seats_paid: 10 })], AS_OF, S);
    expect(metric(shrank, "seat_trend_pct").score).toBe(0); // -25%
    const flat = scoreEngagement(sixMonths(), AS_OF, S);
    expect(metric(flat, "seat_trend_pct").score).toBe(60);
  });

  it("cannot judge a trend from one month", () => {
    expect(metric(scoreEngagement([row(0)], AS_OF, S), "seat_trend_pct").status).toBe("na");
  });
});

describe("scoreProfitability", () => {
  it("scores a customer with no concessions, above-centre rent and accepted escalations", () => {
    const r = scoreProfitability(sixMonths({ rent_per_seat: 5500 }), AS_OF, S, {}, {
      centerRentPerSeat: 5000,
      escalations: ["accepted"],
    });
    // concessions 0% = 100; rent 1.1x centre = 100; accepted = 100.
    expect(r.score).toBeCloseTo(100, 5);
    expect(r.notes.join(" ")).toMatch(/Revenue side only/);
  });

  it("scores heavy concessions at zero", () => {
    // 15% of revenue given away.
    const r = scoreProfitability(sixMonths({ concessions_counted: 7500 }), AS_OF, S, {}, {
      centerRentPerSeat: 5000,
      escalations: ["accepted"],
    });
    expect(metric(r, "concessions_pct").score).toBeCloseTo(0, 5);
  });

  it("marks rent against the center as missing when the center figure is unknown", () => {
    const r = scoreProfitability(sixMonths(), AS_OF, S, {}, { centerRentPerSeat: null });
    expect(metric(r, "rent_vs_center").status).toBe("missing");
    expect(r.confidence).toBeLessThan(1);
  });

  it("averages escalation outcomes and ignores unrecorded ones", () => {
    const mixed = scoreProfitability(sixMonths(), AS_OF, S, {}, { escalations: ["accepted", "avoided"] });
    expect(metric(mixed, "escalation_outcomes").score).toBe(60); // (100 + 20) / 2
    const onlyUnknown = scoreProfitability(sixMonths(), AS_OF, S, {}, { escalations: ["unknown"] });
    expect(metric(onlyUnknown, "escalation_outcomes").status).toBe("na");
  });

  it("has no score when there is no revenue to measure concessions against", () => {
    const r = scoreProfitability(sixMonths({ revenue_ex_gst: 0 }), AS_OF, S, {}, { centerRentPerSeat: null });
    expect(r.score).toBeNull();
  });
});
