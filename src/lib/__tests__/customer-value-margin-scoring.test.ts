import { describe, expect, it } from "vitest";
import { scoreProfitability, type MarginMonth, type MonthlyMetrics } from "@/lib/customer-value/scoring-pillars";
import { DEFAULT_SCORING_SETTINGS, mergeSettings, validateSettings, type ScoringSettings } from "@/lib/customer-value/scoring-settings";
import { compareMarginImpact } from "@/lib/customer-value/margin-impact";
import type { RunCustomer } from "@/lib/customer-value/scoring-run";
import type { CustomerRaw } from "@/lib/customer-value/monthly-metrics";

const AS_OF = "2026-10-01";
const monthsBefore = (n: number): string => {
  const [y, m] = AS_OF.split("-").map(Number);
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
};
const row = (n: number): MonthlyMetrics => ({
  month: monthsBefore(n), revenue_ex_gst: 50_000, invoiced_count: 1, avg_days_late: 0, measured_count: 1, on_time_count: 1, overdue_amount: 0,
  max_days_overdue: 0, reminders: 0, concessions_counted: 0, seats_paid: 10, seats_used_avg: null, rent_per_seat: 5_000, tickets_linked: 0,
  tickets_sla_breached: 0, tickets_reopened: 0, satisfaction_avg: null, satisfaction_count: 0, bookings: 0, billing_queries: 0,
});
const rows = [0, 1, 2, 3, 4, 5].map(row);
const margins = (pct: number, confidence = 1): MarginMonth[] => [1, 2, 3, 4, 5].map((n) => ({ month: monthsBefore(n), margin_pct: pct, confidence }));
const ON: ScoringSettings = { ...DEFAULT_SCORING_SETTINGS, margin: { enabled: true, minConfidence: 0.5 } };

describe("margin in Profitability: switched off (the default)", () => {
  it("changes nothing at all, even when margins are supplied", () => {
    const without = scoreProfitability(rows, AS_OF, DEFAULT_SCORING_SETTINGS);
    const withMargins = scoreProfitability(rows, AS_OF, DEFAULT_SCORING_SETTINGS, {}, { margins: margins(0.05) });
    expect(withMargins).toEqual(without);
    expect(withMargins.metrics.some((m) => m.key === "margin_pct")).toBe(false);
  });

  it("is off in the defaults", () => {
    expect(DEFAULT_SCORING_SETTINGS.margin.enabled).toBe(false);
  });
});

describe("margin in Profitability: switched on", () => {
  const metric = (r: ReturnType<typeof scoreProfitability>) => r.metrics.find((m) => m.key === "margin_pct");

  it("scores a healthy margin high and a thin one low, on the reference scale", () => {
    const high = metric(scoreProfitability(rows, AS_OF, ON, {}, { margins: margins(0.6) }))!;
    const low = metric(scoreProfitability(rows, AS_OF, ON, {}, { margins: margins(0.1) }))!;
    expect(high.status).toBe("ok");
    expect(high.score).toBeCloseTo(100, 6);
    expect(low.score).toBeCloseTo(0, 6);
  });

  it("ignores months where too little of the cost is measured", () => {
    const mixed: MarginMonth[] = [...margins(0.6).slice(0, 2), ...margins(0.0, 0.2).slice(2)];
    const m = metric(scoreProfitability(rows, AS_OF, ON, {}, { margins: mixed }))!;
    expect(m.value).toBeCloseTo(0.6);
  });

  it("is 'does not apply' with no usable margin, so it never lowers the pillar's confidence", () => {
    const base = scoreProfitability(rows, AS_OF, DEFAULT_SCORING_SETTINGS);
    const none = scoreProfitability(rows, AS_OF, ON, {}, { margins: margins(0.5, 0.1) });
    expect(metric(none)!.status).toBe("na");
    expect(none.confidence).toBe(base.confidence);
    expect(none.score).toBe(base.score);
    expect(metric(scoreProfitability(rows, AS_OF, ON))!.status).toBe("na");
  });

  it("ignores months with no margin figure", () => {
    const m = metric(scoreProfitability(rows, AS_OF, ON, {}, { margins: [{ month: monthsBefore(1), margin_pct: null, confidence: 1 }] }))!;
    expect(m.status).toBe("na");
  });

  it("ranks against the center's customers by percentile once there are enough of them", () => {
    const cohort = { margin_pct: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] };
    const m = metric(scoreProfitability(rows, AS_OF, ON, cohort, { margins: margins(0.9) }))!;
    expect(m.method).toBe("percentile");
    expect(m.score!).toBeGreaterThan(80);
  });

  it("only counts months up to the date being scored", () => {
    const future: MarginMonth[] = [{ month: "2026-12-01", margin_pct: 0.6, confidence: 1 }];
    expect(metric(scoreProfitability(rows, AS_OF, ON, {}, { margins: future }))!.status).toBe("na");
  });
});

describe("settings", () => {
  it("accepts a valid override and merges the margin block one level deep", () => {
    const s = mergeSettings({ margin: { enabled: true } as ScoringSettings["margin"] });
    expect(s.margin).toEqual({ enabled: true, minConfidence: 0.5 });
  });

  it("rejects a confidence floor outside 0 to 1", () => {
    expect(validateSettings({ ...DEFAULT_SCORING_SETTINGS, margin: { enabled: true, minConfidence: 1.5 } }).join(" ")).toMatch(/Margin minimum confidence/);
    expect(() => mergeSettings({ margin: { enabled: true, minConfidence: -1 } })).toThrow();
  });
});

describe("compareMarginImpact", () => {
  // A minimal customer with no contracts scores "not enough data" either way: the comparison must still run and report no change.
  const empty: CustomerRaw = {
    contracts: [], statements: [], payments: [], reminders: [], rentWaivers: [], moratoriums: [], bookings: [], bookingWaivers: [], refunds: [],
    creditNotes: [], tickets: [], ticketsUnlinked: 0, billingQueries: null, doorByMonth: null,
  } as unknown as CustomerRaw;
  const customers: RunCustomer[] = [{ leadId: "l1", raw: empty, locationIds: ["c1"], ticketLinkCoverage: null, margins: margins(0.6) }];

  it("reports nothing moving and how many customers had a usable margin", () => {
    const r = compareMarginImpact(customers, AS_OF, DEFAULT_SCORING_SETTINGS);
    expect(r.customers).toBe(1);
    expect(r.withUsableMargin).toBe(1);
    expect(r.tierChanged).toBe(0);
    expect(r.transitions).toEqual({});
  });

  it("counts a customer as usable only when a month clears the confidence floor", () => {
    const low: RunCustomer[] = [{ ...customers[0], margins: margins(0.6, 0.2) }];
    expect(compareMarginImpact(low, AS_OF, DEFAULT_SCORING_SETTINGS).withUsableMargin).toBe(0);
    expect(compareMarginImpact(low, AS_OF, { ...DEFAULT_SCORING_SETTINGS, margin: { enabled: false, minConfidence: 0.1 } }).withUsableMargin).toBe(1);
  });
});
