/**
 * Pure aggregation for the Staff exceptions page. Kept apart from the route so
 * the arithmetic (what counts against a person, the trend, the top reason)
 * is unit tested.
 */

export interface DeviationRow {
  id: string;
  deviation_type: string;
  entity_id: string;
  accountable_user_id: string | null;
  reason_code: string;
  counts_against_person: boolean;
  amount_at_stake: number | string | null;
  recorded_at: string;
  reviewed_at: string | null;
}

export interface PersonSummary {
  user_id: string | null;
  /** Deviations that count against the person in the period. */
  counted: number;
  /** Everything recorded for them, including reasons that aren't their doing. */
  total: number;
  unreviewed: number;
  amount_at_stake: number;
  top_reason: string | null;
  /** counted minus the same figure for the previous period of equal length. */
  trend: number;
}

export interface DeviationSummary {
  people: PersonSummary[];
  reasons: Array<{ reason_code: string; count: number }>;
  totals: { total: number; counted: number; unreviewed: number; amount_at_stake: number };
}

export function summarizeDeviations(
  current: DeviationRow[],
  previous: DeviationRow[],
): DeviationSummary {
  const prevCounted = new Map<string | null, number>();
  for (const r of previous) {
    if (!r.counts_against_person) continue;
    prevCounted.set(r.accountable_user_id, (prevCounted.get(r.accountable_user_id) ?? 0) + 1);
  }

  const byPerson = new Map<string | null, DeviationRow[]>();
  for (const r of current) {
    const list = byPerson.get(r.accountable_user_id) ?? [];
    list.push(r);
    byPerson.set(r.accountable_user_id, list);
  }

  const people: PersonSummary[] = [...byPerson.entries()].map(([userId, rows]) => {
    const counted = rows.filter((r) => r.counts_against_person);
    const reasonCounts = new Map<string, number>();
    // Top reason is over what counts against them: a person with one system
    // outage and one lapse shouldn't be labelled "system problem".
    for (const r of (counted.length > 0 ? counted : rows)) {
      reasonCounts.set(r.reason_code, (reasonCounts.get(r.reason_code) ?? 0) + 1);
    }
    const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      user_id: userId,
      counted: counted.length,
      total: rows.length,
      unreviewed: rows.filter((r) => !r.reviewed_at).length,
      amount_at_stake: rows.reduce((s, r) => s + (Number(r.amount_at_stake) || 0), 0),
      top_reason: top,
      trend: counted.length - (prevCounted.get(userId) ?? 0),
    };
  }).sort((a, b) => b.counted - a.counted || b.total - a.total);

  const reasonTotals = new Map<string, number>();
  for (const r of current) reasonTotals.set(r.reason_code, (reasonTotals.get(r.reason_code) ?? 0) + 1);

  return {
    people,
    reasons: [...reasonTotals.entries()]
      .map(([reason_code, count]) => ({ reason_code, count }))
      .sort((a, b) => b.count - a.count),
    totals: {
      total: current.length,
      counted: current.filter((r) => r.counts_against_person).length,
      unreviewed: current.filter((r) => !r.reviewed_at).length,
      amount_at_stake: current.reduce((s, r) => s + (Number(r.amount_at_stake) || 0), 0),
    },
  };
}
