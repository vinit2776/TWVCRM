import { countsTowardVisits } from "@/lib/amc-lifecycle";

/**
 * Pure rules for combining AMC request lines into one service PO, and for
 * counting visits per asset on a PO that covers several.
 *
 * A PO has exactly one payment schedule and one invoice per cycle, so lines can
 * only share a PO when they pay the same way: same frequency (unit) and same
 * number of cycles (quantity). The cost per cycle then simply adds up.
 */

export interface AmcRequestLine {
  id: string;
  unit?: string | null;
  quantity?: number | string | null;
  estimated_price?: number | string | null;
  linked_asset_id?: string | null;
  already_ordered_qty?: number | null;
}

export type CombineCheck = { ok: true } | { ok: false; reason: string };

export function canCombineLines(lines: AmcRequestLine[]): CombineCheck {
  if (lines.length < 2) return { ok: false, reason: "Select at least two lines to combine." };
  if (lines.some((l) => !l.linked_asset_id)) {
    return { ok: false, reason: "Every line needs an asset to be combined." };
  }
  if (lines.some((l) => Number(l.already_ordered_qty ?? 0) >= Number(l.quantity ?? 0))) {
    return { ok: false, reason: "One of the selected lines is already ordered." };
  }
  const first = lines[0];
  if (lines.some((l) => l.unit !== first.unit)) {
    return { ok: false, reason: "These lines are billed at different frequencies, so they can't share a PO." };
  }
  if (lines.some((l) => Number(l.quantity) !== Number(first.quantity))) {
    return { ok: false, reason: "These lines run for a different number of cycles, so they can't share a PO." };
  }
  return { ok: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cost per cycle of a combined PO: the lines' per-cycle costs added together. */
export function combinedPerCycleCost(lines: AmcRequestLine[]): number {
  return round2(lines.reduce((sum, l) => sum + Number(l.estimated_price ?? 0), 0));
}

/** Counted visits (preventive / annual service) logged per asset. */
export function countedVisitsByAsset(
  events: Array<{ asset_id?: string | null; event_type: string }>,
  assetIds: string[]
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(assetIds.map((a) => [a, 0]));
  for (const e of events) {
    if (!e.asset_id || !(e.asset_id in counts) || !countsTowardVisits(e.event_type)) continue;
    counts[e.asset_id] += 1;
  }
  return counts;
}

/**
 * "Visits used" for a PO that covers several assets. Visits are per asset, so
 * the contract only counts as having used a visit once every asset has had it —
 * the minimum across assets. One asset running out must not exhaust the others.
 */
export function combinedVisitsUsed(counts: Record<string, number>): number {
  const values = Object.values(counts);
  return values.length ? Math.min(...values) : 0;
}
