import { describe, expect, it } from "vitest";
import {
  COMPARE_MEASURES,
  buildComparison,
  compareMeasure,
  customerFigures,
  daysToPayTrend,
  type CompareMonthRow,
} from "@/lib/customer-value/compare-view";

const TODAY = "2026-10-19";

function row(lead: string, month: string, over: Partial<CompareMonthRow> = {}): CompareMonthRow {
  return {
    lead_id: lead, month, avg_days_late: 2, measured_count: 1, on_time_count: 1, reminders: 0,
    seats_paid: 4, seats_used_avg: null, rent_per_seat: 10000, tickets_linked: 0, ...over,
  };
}
const months = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const series = (lead: string, over: Partial<CompareMonthRow> = {}) => months.map((m) => row(lead, m, over));

describe("customerFigures", () => {
  it("weights days to pay by invoices timed and skips months with nothing timed", () => {
    const f = customerFigures([
      row("a", "2026-09-01", { avg_days_late: 10, measured_count: 3 }),
      row("a", "2026-10-01", { avg_days_late: -2, measured_count: 1 }),
      row("a", "2026-08-01", { avg_days_late: null, measured_count: 0 }),
    ], TODAY);
    expect(f.daysToPay).toBeCloseTo((30 - 2) / 4);
  });

  it("leaves seat use null without door data, never zero", () => {
    expect(customerFigures(series("a"), TODAY).seatUse).toBeNull();
    expect(customerFigures(series("a", { seats_used_avg: 2 }), TODAY).seatUse).toBeCloseTo(50);
  });

  it("only looks at the recent window", () => {
    const f = customerFigures([row("a", "2025-01-01", { avg_days_late: 99 }), row("a", "2026-10-01", { avg_days_late: 1 })], TODAY);
    expect(f.daysToPay).toBe(1);
  });

  it("scales reminders and tickets to a quarter", () => {
    const f = customerFigures(series("a", { reminders: 1, tickets_linked: 1 }), TODAY);
    expect(f.remindersPerQuarter).toBe(3);
    expect(f.ticketsPerSeat).toBeCloseTo(0.75);
  });
});

describe("compareMeasure", () => {
  const days = COMPARE_MEASURES.find((m) => m.key === "daysToPay")!;
  const rent = COMPARE_MEASURES.find((m) => m.key === "rentPerSeat")!;
  const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("ranks the lowest days to pay first and shares ties", () => {
    expect(compareMeasure(days, 0, peers).rank).toBe(1);
    expect(compareMeasure(days, 5, peers).rank).toBe(5);
    expect(compareMeasure(days, 20, peers).rank).toBe(10);
  });

  it("judges only with enough peers", () => {
    expect(compareMeasure(days, 1, peers).standing).toBe("better");
    expect(compareMeasure(days, 20, peers).standing).toBe("worse");
    expect(compareMeasure(days, 5, peers).standing).toBe("typical");
    expect(compareMeasure(days, 1, [3, 4, 5]).standing).toBeNull();
  });

  it("never judges a fact such as rent", () => {
    expect(compareMeasure(rent, 5, peers).standing).toBeNull();
  });

  it("returns nothing to compare when the customer has no figure", () => {
    const c = compareMeasure(days, null, peers);
    expect(c.rank).toBeNull();
    expect(c.difference).toBeNull();
    expect(c.bins.some((b) => b.mine)).toBe(false);
  });

  it("marks the bin holding the customer in the histogram", () => {
    const c = compareMeasure(days, 9, peers);
    expect(c.bins.filter((b) => b.mine)).toHaveLength(1);
    expect(c.bins.reduce((n, b) => n + b.count, 0)).toBe(peers.length);
  });
});

describe("buildComparison", () => {
  it("excludes the customer and short-history peers from the cohort", () => {
    const rows = [
      ...series("me", { avg_days_late: 1 }),
      ...Array.from({ length: 9 }, (_, i) => series(`p${i}`, { avg_days_late: 5 })).flat(),
      ...series("new").slice(0, 2),
    ];
    const r = buildComparison("me", rows, TODAY);
    expect(r.peerCount).toBe(9);
    expect(r.judged).toBe(true);
    const d = r.measures.find((m) => m.key === "daysToPay")!;
    expect(d.mean).toBe(5);
    expect(d.mine).toBe(1);
    expect(d.standing).toBe("better");
  });

  it("is not judged with a small center", () => {
    const r = buildComparison("me", [...series("me"), ...series("p1"), ...series("p2")], TODAY);
    expect(r.judged).toBe(false);
    expect(r.measures.every((m) => m.standing === null)).toBe(true);
  });
});

describe("daysToPayTrend", () => {
  it("gives twelve months ending this month, with gaps as null", () => {
    const t = daysToPayTrend([row("me", "2026-10-01", { avg_days_late: 3 })], [row("p", "2026-10-01", { avg_days_late: 6 })], TODAY);
    expect(t).toHaveLength(12);
    expect(t[11]).toEqual({ month: "2026-10-01", mine: 3, center: 6 });
    expect(t[0].month).toBe("2025-11-01");
    expect(t[0].mine).toBeNull();
  });
});
