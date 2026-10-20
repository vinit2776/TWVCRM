import { describe, it, expect } from "vitest";
import {
  scoreCustomer,
  tierFor,
  trendBetween,
  type CustomerScoreInput,
} from "@/lib/customer-value/scoring-overall";
import type { MonthlyMetrics } from "@/lib/customer-value/scoring-pillars";
import { DEFAULT_SCORING_SETTINGS as S, mergeSettings } from "@/lib/customer-value/scoring-settings";

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

const rows = (over: (n: number) => Partial<MonthlyMetrics> = () => ({})) => [0, 1, 2, 3, 4, 5].map((n) => row(n, over(n)));

/** A strong, established customer. */
const strong: CustomerScoreInput = {
  rows: rows(),
  tenureMonths: 12,
  renewal: { renewed: 1, declined: 0 },
  centerRentPerSeat: 5000,
  escalations: ["accepted"],
};

describe("tierFor", () => {
  it("applies the agreed cut-offs at their edges", () => {
    expect(tierFor(100, S.tierCutoffs)).toBe("A");
    expect(tierFor(75, S.tierCutoffs)).toBe("A");
    expect(tierFor(74.99, S.tierCutoffs)).toBe("B");
    expect(tierFor(60, S.tierCutoffs)).toBe("B");
    expect(tierFor(59.99, S.tierCutoffs)).toBe("C");
    expect(tierFor(40, S.tierCutoffs)).toBe("C");
    expect(tierFor(39.99, S.tierCutoffs)).toBe("D");
    expect(tierFor(0, S.tierCutoffs)).toBe("D");
  });
});

describe("trendBetween", () => {
  it("calls a move of the threshold or more up or down", () => {
    expect(trendBetween(80, 75, 5)).toBe("up");
    expect(trendBetween(70, 75, 5)).toBe("down");
  });
  it("calls anything smaller flat", () => {
    expect(trendBetween(79.9, 75, 5)).toBe("flat");
    expect(trendBetween(70.1, 75, 5)).toBe("flat");
    expect(trendBetween(75, 75, 5)).toBe("flat");
  });
  it("has no trend when either end is missing", () => {
    expect(trendBetween(null, 75, 5)).toBeNull();
    expect(trendBetween(75, null, 5)).toBeNull();
  });
});

describe("scoreCustomer", () => {
  it("grades a strong established customer an A", () => {
    const score = scoreCustomer(strong, AS_OF);
    expect(score.status).toBe("graded");
    expect(score.reason).toBeNull();
    expect(score.tier).toBe("A");
    expect(score.overall).toBeGreaterThanOrEqual(90);
    expect(score.confidentPillars.sort()).toEqual(["engagement", "friction", "payment", "profitability"]);
  });

  it("renormalises the pillar weights so they sum to one", () => {
    const score = scoreCustomer(strong, AS_OF);
    const total = Object.values(score.weightsUsed).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(score.weightsUsed.profitability).toBeCloseTo(0.35, 10);
    expect(score.weightsUsed.payment).toBeCloseTo(0.25, 10);
  });

  it("leaves a pillar out of the tier when it lacks confidence, and spreads its weight over the rest", () => {
    // No seat counts and no door data: Engagement and the ticket-per-seat measure cannot be judged.
    const input: CustomerScoreInput = {
      ...strong,
      rows: rows(() => ({ seats_paid: null, seats_used_avg: null, rent_per_seat: null, bookings: 0 })),
      renewal: undefined,
    };
    const score = scoreCustomer(input, AS_OF);
    expect(score.pillars.engagement.score).toBeNull();
    expect(score.confidentPillars).not.toContain("engagement");
    expect(score.weightsUsed.engagement).toBe(0);
    const total = Object.values(score.weightsUsed).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("will not grade a customer with under three months of history", () => {
    const score = scoreCustomer({ ...strong, tenureMonths: 2 }, AS_OF);
    expect(score).toMatchObject({ status: "not_enough_data", tier: null, overall: null });
    expect(score.reason).toMatch(/3 months/);
  });

  it("will not grade a customer who has never been active", () => {
    expect(scoreCustomer({ ...strong, tenureMonths: null }, AS_OF).status).toBe("not_enough_data");
  });

  it("will not grade on a single confident pillar", () => {
    // No revenue means no concessions share and no overdue ratio; no seats means nothing else can be judged.
    const input: CustomerScoreInput = {
      rows: rows(() => ({ revenue_ex_gst: 0, seats_paid: null, seats_used_avg: null, rent_per_seat: null, bookings: 0, billing_queries: null })),
      tenureMonths: 12,
    };
    const score = scoreCustomer(input, AS_OF);
    expect(score.confidentPillars).toEqual(["payment"]);
    expect(score.status).toBe("not_enough_data");
    expect(score.reason).toMatch(/Only 1 of 4/);
  });

  it("lets the confident-pillar rule be tuned", () => {
    const strict = mergeSettings({ minConfidentPillars: 4 });
    const input: CustomerScoreInput = { ...strong, escalations: undefined, centerRentPerSeat: null };
    // Profitability can still be judged on concessions alone (weight 50 of 80), so all four qualify.
    expect(scoreCustomer(input, AS_OF, strict).status).toBe("graded");
    const thin = { ...input, rows: rows(() => ({ revenue_ex_gst: 0 })) };
    expect(scoreCustomer(thin, AS_OF, strict).status).toBe("not_enough_data");
  });

  it("grades a struggling customer low", () => {
    const input: CustomerScoreInput = {
      rows: rows(() => ({
        avg_days_late: 20,
        on_time_count: 0,
        reminders: 2,
        overdue_amount: 50000,
        max_days_overdue: 45,
        tickets_linked: 3,
        tickets_sla_breached: 2,
        tickets_reopened: 1,
        seats_used_avg: 3,
        concessions_counted: 10000,
        bookings: 0,
      })),
      tenureMonths: 14,
      renewal: { renewed: 0, declined: 1 },
      centerRentPerSeat: 8000,
      escalations: ["avoided"],
    };
    const score = scoreCustomer(input, AS_OF);
    expect(score.status).toBe("graded");
    expect(["C", "D"]).toContain(score.tier);
    expect(score.overall as number).toBeLessThan(40);
  });

  it("reproduces a past score exactly, even when later months are terrible", () => {
    const history = [
      ...[0, 1, 2, 3, 4, 5].map((n) => row(n + 4)), // April..September are fine
    ];
    const later = [0, 1, 2, 3].map((n) =>
      row(n, { avg_days_late: 30, on_time_count: 0, max_days_overdue: 60, overdue_amount: 100000, tickets_linked: 5, tickets_sla_breached: 5 })
    );
    const asOfPast = monthsBefore(4);
    const knownThen = scoreCustomer({ ...strong, rows: history }, asOfPast);
    const withFuture = scoreCustomer({ ...strong, rows: [...history, ...later] }, asOfPast);
    expect(withFuture.overall).toBe(knownThen.overall);
    expect(withFuture.tier).toBe(knownThen.tier);
    expect(withFuture.pillars.payment.score).toBe(knownThen.pillars.payment.score);
    // And today's score does see the bad months.
    const now = scoreCustomer({ ...strong, rows: [...history, ...later] }, AS_OF);
    expect(now.overall as number).toBeLessThan(knownThen.overall as number);
  });

  it("records the as-of month it was computed for", () => {
    expect(scoreCustomer(strong, AS_OF).asOf).toBe(AS_OF);
  });
});

describe("weak pillar cap", () => {
  // Always very late (Payment 30) but strong everywhere else.
  const lateButOtherwiseStrong: CustomerScoreInput = {
    ...strong,
    rows: rows(() => ({ avg_days_late: 20, on_time_count: 0 })),
  };

  it("is off by default, so a very late payer can still grade A", () => {
    const score = scoreCustomer(lateButOtherwiseStrong, AS_OF);
    expect(score.pillars.payment.score as number).toBeLessThan(35);
    expect(score.tier).toBe("A");
    expect(score.tierCap).toBeNull();
  });

  it("limits the tier when a confident pillar falls below the floor", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 35, maxTier: "B" } });
    const score = scoreCustomer(lateButOtherwiseStrong, AS_OF, capped);
    expect(score.overall as number).toBeGreaterThanOrEqual(75); // would have been A
    expect(score.tier).toBe("B");
    expect(score.tierCap).toEqual({ pillar: "payment", maxTier: "B" });
  });

  it("leaves a customer with no weak pillar alone", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 35, maxTier: "B" } });
    const score = scoreCustomer(strong, AS_OF, capped);
    expect(score.tier).toBe("A");
    expect(score.tierCap).toBeNull();
  });

  it("does nothing when the tier is already at or below the cap", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 35, maxTier: "B" } });
    const score = scoreCustomer(
      {
        rows: rows(() => ({ avg_days_late: 20, on_time_count: 0, reminders: 2, overdue_amount: 50000, max_days_overdue: 45, tickets_linked: 3, tickets_sla_breached: 2, seats_used_avg: 3, concessions_counted: 10000, bookings: 0 })),
        tenureMonths: 14,
        renewal: { renewed: 0, declined: 1 },
        centerRentPerSeat: 8000,
        escalations: ["avoided"],
      },
      AS_OF,
      capped
    );
    expect(["C", "D"]).toContain(score.tier);
    expect(score.tierCap).toBeNull();
  });

  it("ignores a weak pillar that lacks the confidence to count", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 35, maxTier: "B" } });
    // Engagement has no seat counts and no door data, so it is not confident and cannot cap anything.
    const score = scoreCustomer(
      { ...strong, rows: rows(() => ({ seats_paid: null, seats_used_avg: null, bookings: 0 })), renewal: undefined },
      AS_OF,
      capped
    );
    expect(score.confidentPillars).not.toContain("engagement");
    expect(score.tierCap).toBeNull();
  });

  it("can cap to any tier", () => {
    const capped = mergeSettings({ weakPillarCap: { below: 35, maxTier: "C" } });
    expect(scoreCustomer(lateButOtherwiseStrong, AS_OF, capped).tier).toBe("C");
  });

  it("rejects a nonsense floor or tier", () => {
    expect(() => mergeSettings({ weakPillarCap: { below: 0, maxTier: "B" } })).toThrow(/floor/);
    expect(() => mergeSettings({ weakPillarCap: { below: 35, maxTier: "Z" as never } })).toThrow(/cap tier/);
  });
});

