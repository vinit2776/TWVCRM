// The OneGrid client types a telemetry response's `series` as
// Record<string, any>[] (the shape varies by which `fields` were
// requested), so this accepts that same loose shape rather than a stricter
// interface — matching how callers already read `r.ts` / `r.energy_delta_wh`
// off it directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnegridSeriesRow = Record<string, any>;

export interface LedgerDeltaRow {
  ts: string;
  cumulative_wh: number | null;
  energy_delta_wh: number | null;
}

// OneGrid's own `derive=delta` field, when computed over a wide backfill
// query, has been observed to smooth/interpolate across gaps instead of
// returning the true per-bucket delta — caught by comparing it against the
// same series' own cumulative_wh column (the raw meter reading, monotonic,
// doesn't lie): six consecutive 15-min buckets all reported an identical
// delta while their cumulative readings implied six different values. A
// live/narrow query never showed this, only wide backfills.
//
// Recomputing delta locally as the difference between consecutive
// cumulative readings sidesteps whatever OneGrid's wide-query delta
// computation is doing. `previous` seeds the very first row of the batch —
// pass the last row already on record (from the ledger, or the prior chunk
// in a multi-chunk sync) so that row gets a real delta too, not just rows
// 2..n of the batch.
//
// A cumulative diff is only a per-bucket delta if the two readings are
// adjacent. When the previous reading is more than MAX_DELTA_GAP_MS older
// (the meter was offline, or the capture simply didn't run for days), the
// diff is the whole gap's usage — on 2026-10-03 one 15-minute row held ~9
// days (1,269,500 Wh). Such a row stores a null delta instead: its
// cumulative_wh stays intact (still the true meter reading, and the seed for
// the next row), and every consumer already skips null deltas. OneGrid's own
// value is deliberately not substituted — it is the field known to smooth
// across gaps.
export const MAX_DELTA_GAP_MS = 60 * 60 * 1000;

export interface LedgerSeed {
  ts: string;
  cumulative_wh: number | null;
}

export function recomputeDeltasFromCumulative(
  series: OnegridSeriesRow[],
  previous: LedgerSeed | null
): LedgerDeltaRow[] {
  let prevCumulative = previous?.cumulative_wh ?? null;
  let prevMs = previous?.ts ? new Date(previous.ts).getTime() : null;
  return series.map((r) => {
    const cumulative = r.Energy_Consumption_Cumulative_Wh ?? null;
    const ms = new Date(r.ts).getTime();
    let delta: number | null;
    if (cumulative != null && prevCumulative != null) {
      const spansGap = prevMs != null && ms - prevMs > MAX_DELTA_GAP_MS;
      delta = spansGap ? null : cumulative - prevCumulative;
    } else {
      // No local ground truth to diff against yet (the very first bucket of
      // this location+device's whole history) — OneGrid's own value is the
      // best available for just this one row.
      delta = r.energy_delta_wh ?? null;
    }
    if (cumulative != null) {
      prevCumulative = cumulative;
      prevMs = ms;
    }
    return { ts: r.ts, cumulative_wh: cumulative, energy_delta_wh: delta };
  });
}
