/**
 * Customer Value — reading the stored shadow margin for scoring.
 *
 * One read of `customer_value_margin` for everyone, grouped by customer. Only
 * called when margin scoring is switched on, so with it off scoring makes no
 * extra query. A table that does not exist yet (migration not applied here) is
 * "no margin", never a failed run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, isMissingTableError } from "@/lib/customer-value/query-helpers";
import type { MarginMonth } from "@/lib/customer-value/scoring-pillars";

interface Row {
  lead_id: string;
  month: string;
  margin_pct: number | string | null;
  confidence: number | string | null;
}

export async function loadMarginsByLead(supabase: SupabaseClient): Promise<Map<string, MarginMonth[]>> {
  let rows: Row[];
  try {
    rows = await fetchAllPages<Row>("margins", (from, to) =>
      supabase.from("customer_value_margin").select("lead_id, month, margin_pct, confidence").order("lead_id").order("month").range(from, to).returns<Row[]>()
    );
  } catch (err) {
    if (isMissingTableError(err)) return new Map();
    throw err;
  }
  const out = new Map<string, MarginMonth[]>();
  for (const r of rows) {
    const list = out.get(r.lead_id) ?? [];
    list.push({
      month: r.month,
      margin_pct: r.margin_pct === null ? null : Number(r.margin_pct),
      confidence: r.confidence === null ? null : Number(r.confidence),
    });
    out.set(r.lead_id, list);
  }
  return out;
}
