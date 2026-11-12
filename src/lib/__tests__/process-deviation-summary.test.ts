import { describe, it, expect } from "vitest";
import { summarizeDeviations, type DeviationRow } from "../process-deviation-summary";

let n = 0;
const row = (over: Partial<DeviationRow>): DeviationRow => ({
  id: `d${++n}`,
  deviation_type: "late_close_out",
  entity_id: `e${n}`,
  accountable_user_id: "u1",
  reason_code: "staff_forgot",
  counts_against_person: true,
  amount_at_stake: 0,
  recorded_at: "2026-10-20T00:00:00Z",
  reviewed_at: null,
  ...over,
});

describe("summarizeDeviations", () => {
  it("groups by accountable person and ranks by what counts against them", () => {
    const s = summarizeDeviations(
      [row({}), row({}), row({ accountable_user_id: "u2" })],
      [],
    );
    expect(s.people.map((p) => [p.user_id, p.counted])).toEqual([["u1", 2], ["u2", 1]]);
  });

  it("records but does not count reasons that aren't the person's doing", () => {
    const s = summarizeDeviations(
      [row({ reason_code: "system_problem", counts_against_person: false }), row({})],
      [],
    );
    const p = s.people[0];
    expect(p.total).toBe(2);
    expect(p.counted).toBe(1);
    expect(p.top_reason).toBe("staff_forgot");
    expect(s.totals).toMatchObject({ total: 2, counted: 1 });
  });

  it("falls back to the recorded reason when nothing counts against them", () => {
    const s = summarizeDeviations(
      [row({ reason_code: "system_problem", counts_against_person: false })],
      [],
    );
    expect(s.people[0].counted).toBe(0);
    expect(s.people[0].top_reason).toBe("system_problem");
  });

  it("computes the trend against the previous period", () => {
    const s = summarizeDeviations([row({}), row({}), row({})], [row({})]);
    expect(s.people[0].trend).toBe(2);
    const down = summarizeDeviations([row({})], [row({}), row({}), row({})]);
    expect(down.people[0].trend).toBe(-2);
  });

  it("sums money at stake and unreviewed", () => {
    const s = summarizeDeviations(
      [row({ amount_at_stake: "1180.00" }), row({ amount_at_stake: 500, reviewed_at: "2026-10-21T00:00:00Z" })],
      [],
    );
    expect(s.totals.amount_at_stake).toBe(1680);
    expect(s.totals.unreviewed).toBe(1);
    expect(s.people[0].unreviewed).toBe(1);
  });

  it("orders the reason mix by count", () => {
    const s = summarizeDeviations(
      [row({ reason_code: "payment_confusion" }), row({ reason_code: "payment_confusion" }), row({ reason_code: "other" })],
      [],
    );
    expect(s.reasons[0]).toEqual({ reason_code: "payment_confusion", count: 2 });
  });

  it("handles no data", () => {
    const s = summarizeDeviations([], []);
    expect(s.people).toEqual([]);
    expect(s.totals).toEqual({ total: 0, counted: 0, unreviewed: 0, amount_at_stake: 0 });
  });
});
