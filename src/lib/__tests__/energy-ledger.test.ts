import { describe, it, expect } from "vitest";
import { recomputeDeltasFromCumulative, MAX_DELTA_GAP_MS } from "../energy-ledger";

const Q = 15 * 60 * 1000;
const T0 = new Date("2026-10-03T06:00:00Z").getTime();
const at = (i: number) => new Date(T0 + i * Q).toISOString();
const row = (i: number, cumulative: number | null, oneGridDelta: number | null = 111) => ({
  ts: at(i),
  Energy_Consumption_Cumulative_Wh: cumulative,
  energy_delta_wh: oneGridDelta,
});

describe("recomputeDeltasFromCumulative", () => {
  it("diffs consecutive cumulative readings, including the seeded first row", () => {
    const out = recomputeDeltasFromCumulative(
      [row(0, 1100), row(1, 1250), row(2, 1250)],
      { ts: at(-1), cumulative_wh: 1000 }
    );
    expect(out.map((r) => r.energy_delta_wh)).toEqual([100, 150, 0]);
    expect(out.map((r) => r.cumulative_wh)).toEqual([1100, 1250, 1250]);
  });

  it("stores null for a first row that follows a multi-day gap, keeping cumulative_wh", () => {
    // The 2026-10-03 production case: ~9 days between the last stored row and
    // the first new one.
    const out = recomputeDeltasFromCumulative(
      [row(0, 244_664_400, 1_269_500), row(1, 244_664_900)],
      { ts: "2026-09-24T03:45:00Z", cumulative_wh: 243_394_900 }
    );
    expect(out[0]).toEqual({ ts: at(0), cumulative_wh: 244_664_400, energy_delta_wh: null });
    // The cumulative reading still seeds the next row, which is a normal 15-min delta.
    expect(out[1].energy_delta_wh).toBe(500);
  });

  it("does not fall back to OneGrid's own delta across a gap", () => {
    const [first] = recomputeDeltasFromCumulative(
      [row(0, 5000, 999_999)],
      { ts: new Date(T0 - 3 * 60 * 60 * 1000).toISOString(), cumulative_wh: 1000 }
    );
    expect(first.energy_delta_wh).toBeNull();
  });

  it("treats exactly the threshold as contiguous and anything beyond as a gap", () => {
    const seed = (gapMs: number) => ({ ts: new Date(T0 - gapMs).toISOString(), cumulative_wh: 1000 });
    expect(recomputeDeltasFromCumulative([row(0, 1400)], seed(MAX_DELTA_GAP_MS))[0].energy_delta_wh).toBe(400);
    expect(recomputeDeltasFromCumulative([row(0, 1400)], seed(MAX_DELTA_GAP_MS + 1000))[0].energy_delta_wh).toBeNull();
  });

  it("tolerates a few missing buckets inside the threshold", () => {
    const out = recomputeDeltasFromCumulative([row(0, 1300)], { ts: at(-3), cumulative_wh: 1000 }); // 45 min
    expect(out[0].energy_delta_wh).toBe(300);
  });

  it("nulls a delta that spans a gap inside the batch, not only the first row", () => {
    const out = recomputeDeltasFromCumulative(
      [row(0, 1100), row(1, 1200), row(40, 9000), row(41, 9100)],
      { ts: at(-1), cumulative_wh: 1000 }
    );
    expect(out.map((r) => r.energy_delta_wh)).toEqual([100, 100, null, 100]);
  });

  it("falls back to OneGrid's value only when there is no previous reading at all", () => {
    const out = recomputeDeltasFromCumulative([row(0, 5000, 321), row(1, 5100, 7)], null);
    expect(out.map((r) => r.energy_delta_wh)).toEqual([321, 100]);
  });

  it("falls back to OneGrid's value when the seed has no cumulative reading", () => {
    const out = recomputeDeltasFromCumulative([row(0, 5000, 321)], { ts: at(-1), cumulative_wh: null });
    expect(out[0].energy_delta_wh).toBe(321);
  });

  it("measures the gap from the last row that had a cumulative reading", () => {
    const out = recomputeDeltasFromCumulative(
      [row(0, 1100), row(1, null, null), row(2, 1300)],
      { ts: at(-1), cumulative_wh: 1000 }
    );
    expect(out.map((r) => r.energy_delta_wh)).toEqual([100, null, 200]);
  });

  it("stores null, not a negative delta, when the seed is newer than the first row (18:45Z case)", () => {
    // Production af667754 / ETG2USP024_5: sync seeded from a row after UTC
    // midnight while OneGrid returned rows from IST midnight (18:30Z).
    const out = recomputeDeltasFromCumulative(
      [
        { ts: "2026-09-18T18:45:00Z", Energy_Consumption_Cumulative_Wh: 2100, energy_delta_wh: 100 },
        { ts: "2026-09-18T19:00:00Z", Energy_Consumption_Cumulative_Wh: 2200, energy_delta_wh: 100 },
      ],
      { ts: "2026-09-19T00:00:00Z", cumulative_wh: 4000 }
    );
    expect(out[0].energy_delta_wh).toBeNull();
    expect(out[0].cumulative_wh).toBe(2100);
    expect(out[1].energy_delta_wh).toBe(100);
  });

  it("computes the real delta when seeded from the row strictly before the first returned row", () => {
    const [first] = recomputeDeltasFromCumulative(
      [{ ts: "2026-09-18T18:45:00Z", Energy_Consumption_Cumulative_Wh: 2100, energy_delta_wh: null }],
      { ts: "2026-09-18T18:30:00Z", cumulative_wh: 2000 }
    );
    expect(first.energy_delta_wh).toBe(100);
  });

  it("stores null for a negative cumulative diff and does not poison the next row", () => {
    const out = recomputeDeltasFromCumulative(
      [row(0, 900), row(1, 1000)],
      { ts: at(-1), cumulative_wh: 1000 }
    );
    expect(out.map((r) => r.energy_delta_wh)).toEqual([null, 100]);
  });

  it("stores null when the seed has the same timestamp as the row", () => {
    const [first] = recomputeDeltasFromCumulative([row(0, 1100)], { ts: at(0), cumulative_wh: 1000 });
    expect(first.energy_delta_wh).toBeNull();
  });
});
