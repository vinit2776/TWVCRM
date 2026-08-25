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
// computation is doing. `previousCumulativeWh` seeds the very first row of
// the batch — pass the last cumulative_wh already on record (from the
// ledger, or the prior chunk in a multi-chunk sync) so that row gets a real
// delta too, not just rows 2..n of the batch.
export function recomputeDeltasFromCumulative(
  series: OnegridSeriesRow[],
  previousCumulativeWh: number | null
): LedgerDeltaRow[] {
  let prevCumulative = previousCumulativeWh;
  return series.map((r) => {
    const cumulative = r.Energy_Consumption_Cumulative_Wh ?? null;
    // No local ground truth to diff against yet (the very first bucket of
    // this location+device's whole history) — OneGrid's own value is the
    // best available for just this one row.
    const delta = cumulative != null && prevCumulative != null
      ? cumulative - prevCumulative
      : (r.energy_delta_wh ?? null);
    if (cumulative != null) prevCumulative = cumulative;
    return { ts: r.ts, cumulative_wh: cumulative, energy_delta_wh: delta };
  });
}
