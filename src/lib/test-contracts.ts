import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * IDs of contracts flagged `is_test_contract` (see migration 00568) — created
 * for internal testing, with no real customer or payment attached. Used to
 * exclude their fake billing/usage data from financial reports and dashboards
 * that read a child table (billing_statements, usage_charges, ...) without
 * otherwise touching `contracts`.
 */
export async function getTestContractIds(
  supabase: SupabaseClient = createAdminClient()
): Promise<string[]> {
  const { data } = await supabase.from("contracts").select("id").eq("is_test_contract", true);
  return (data ?? []).map((row) => row.id as string);
}

/**
 * Postgrest `in`-list literal for `.not("contract_id", "in", ...)`.
 * Returns null when there's nothing to exclude, since `.not(col, "in", "()")`
 * is invalid syntax — callers should skip applying the filter in that case.
 *
 * Only safe on a NOT NULL contract_id column (e.g. contract_payments) — a
 * plain `.not(col, "in", ...)` evaluates to NULL (excluded) for NULL rows,
 * which would wrongly drop legitimate no-contract records. For a nullable
 * contract_id column (billing_statements, usage_charges, ...), use
 * `excludeTestContractsOrFilter` instead.
 */
export function testContractIdsFilter(ids: string[]): string | null {
  return ids.length > 0 ? `(${ids.join(",")})` : null;
}

/**
 * Postgrest `.or(...)` filter string that excludes rows belonging to a test
 * contract while still keeping rows where `column` is NULL (a legitimate
 * no-contract record — e.g. a case-billed or booking-only statement/charge).
 * Returns null when there's nothing to exclude — callers should skip
 * applying the filter in that case.
 */
export function excludeTestContractsOrFilter(column: string, ids: string[]): string | null {
  if (ids.length === 0) return null;
  return `${column}.is.null,${column}.not.in.(${ids.join(",")})`;
}
