/**
 * app-settings-cache.ts
 *
 * Module-level in-process cache for the `app_settings` table.
 *
 * PROBLEM: app_settings (Razorpay keys, webhook secret, UPI ID, etc.) was
 * fetched from the DB on every invocation of:
 *   - the Razorpay webhook handler (every incoming payment event)
 *   - send-proforma.ts dispatchProforma/dispatchGstDirect (once per contract per billing run)
 *   - payment-reminder.ts sendOneReminder (once per overdue statement per day)
 *   - proposals/accept, proposals/send-invoice (every invocation)
 *
 * On a 50-contract billing run this was 100+ redundant round-trips for data
 * that changes at most a few times per year.
 *
 * SOLUTION: cache the full settings Map per-key in module scope with a TTL.
 * Vercel serverless functions share module state within the same warm instance,
 * so this eliminates repeated DB hits within the same invocation and across
 * requests handled by the same warm lambda.
 *
 * TTL is set to 5 minutes (300 s) — short enough to pick up settings changes
 * within a reasonable window, long enough to absorb entire billing runs.
 *
 * Usage:
 *   const webhookSecret = await getCachedSetting(adminSupabase, "razorpay_webhook_secret");
 *   const keys = await getCachedSettings(adminSupabase, ["razorpay_key_id", "razorpay_key_secret"]);
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string | null;
  fetchedAt: number;
}

// Module-level cache — lives for the lifetime of the warm serverless instance.
const cache = new Map<string, CacheEntry>();

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

/**
 * Get a single app_setting value by key.
 * Returns null if the key doesn't exist.
 */
export async function getCachedSetting(
  supabase: SupabaseClient,
  key: string
): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && !isExpired(cached)) return cached.value;

  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .single();

  const value = data?.value ?? null;
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * Get multiple app_setting values in a single DB round-trip.
 * Returns a Record<key, value | null>.
 */
export async function getCachedSettings(
  supabase: SupabaseClient,
  keys: string[]
): Promise<Record<string, string | null>> {
  const now = Date.now();
  const missing: string[] = [];
  const result: Record<string, string | null> = {};

  for (const key of keys) {
    const cached = cache.get(key);
    if (cached && !isExpired(cached)) {
      result[key] = cached.value;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", missing);

    // Seed result with nulls for all missing keys (handles not-found case)
    for (const key of missing) {
      result[key] = null;
      cache.set(key, { value: null, fetchedAt: now });
    }

    // Overwrite with actual values from DB
    for (const row of data ?? []) {
      result[row.key] = row.value ?? null;
      cache.set(row.key, { value: row.value ?? null, fetchedAt: now });
    }
  }

  return result;
}

/** Evict a key from cache (e.g., after a settings update). */
export function evictCachedSetting(key: string): void {
  cache.delete(key);
}

/** Clear the entire cache (useful in tests). */
export function clearSettingsCache(): void {
  cache.clear();
}
