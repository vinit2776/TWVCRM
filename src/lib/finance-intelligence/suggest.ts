/**
 * Generic "learn from history" helpers used by multiple FI features.
 *
 * Every function here is pure-ish — takes a Supabase client + a vendor /
 * entity id + a lookback window, returns aggregated stats. No UI logic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { lookbackCutoff } from "./settings";

// ─── 1. Recent bills for a vendor ────────────────────────────────────────────

export interface VendorBillHistorySlim {
  id: string;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  payment_batch_type: string | null;
  payment_batch_date: string | null;
  approved_at: string | null;
  notes: string | null;
}

/** Get the N most-recent approved bills for a vendor, within the lookback window. */
export async function getRecentBillsForVendor(
  supabase: SupabaseClient,
  vendorId: string,
  opts: { lookbackMonths: number; limit?: number; includeUnapproved?: boolean } = { lookbackMonths: 6 },
): Promise<VendorBillHistorySlim[]> {
  const cutoff = lookbackCutoff(opts.lookbackMonths);
  let q = supabase
    .from("vendor_bills")
    .select("id, invoice_date, due_date, total_amount, payment_batch_type, payment_batch_date, approved_at, notes")
    .eq("vendor_id", vendorId)
    .gte("invoice_date", cutoff.split("T")[0])
    .order("invoice_date", { ascending: false })
    .limit(opts.limit ?? 10);
  if (!opts.includeUnapproved) q = q.eq("approval_status", "approved");
  const { data } = await q;
  return (data ?? []) as VendorBillHistorySlim[];
}

// ─── 2. Most-frequent value picker ───────────────────────────────────────────

/**
 * Generic helper: from a list of values, return the most common one.
 * Tie-break: most recent value (caller orders array newest→oldest).
 *
 * Returns null if the list is empty or all values are null/undefined.
 */
export function mostFrequent<T extends string | number>(values: (T | null | undefined)[]): T | null {
  const counts = new Map<T, { count: number; firstIndex: number }>();
  values.forEach((v, idx) => {
    if (v === null || v === undefined) return;
    const prev = counts.get(v);
    if (prev) prev.count++;
    else counts.set(v, { count: 1, firstIndex: idx });
  });
  if (counts.size === 0) return null;

  let best: T | null = null;
  let bestCount = 0;
  let bestIndex = Infinity;
  for (const [v, { count, firstIndex }] of counts) {
    if (count > bestCount || (count === bestCount && firstIndex < bestIndex)) {
      best = v;
      bestCount = count;
      bestIndex = firstIndex;
    }
  }
  return best;
}

// ─── 3. Average / median helpers ─────────────────────────────────────────────

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── 4. Vendor's typical net-days (invoice → due) ────────────────────────────

/** Average days between invoice_date and due_date for a vendor. */
export function averageNetDays(history: VendorBillHistorySlim[]): number | null {
  const diffs: number[] = [];
  for (const b of history) {
    if (!b.due_date) continue;
    const inv = new Date(b.invoice_date);
    const due = new Date(b.due_date);
    const diff = Math.round((due.getTime() - inv.getTime()) / 86_400_000);
    if (diff > 0 && diff < 365) diffs.push(diff);  // sanity guard
  }
  if (!diffs.length) return null;
  return Math.round(median(diffs));  // median is more robust to outliers than mean
}
