import type { SupabaseClient } from "@supabase/supabase-js";
import { HOLDOVER_CLAUSE_CODE } from "@/lib/vo-terms-assemble";

// Deploy precedes the hand-applied migrations, so a missing table or column is a normal state.
// PGRST205 / PGRST204 are PostgREST schema-cache misses (table / column) for the same state.
const NOT_MIGRATED = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);

export type HoldoverClauseStatus =
  | { approved: true }
  | { approved: false; reason: "not_migrated" | "no_current_version" | "not_approved" | "lookup_failed" };

/**
 * Has legal approved the current version of the holdover clause (T13) in the terms library?
 * Holdover billing charges customers money, so every doubtful state reads as NOT approved:
 * a library that is not migrated yet, a missing clause, an unapproved version, a failed lookup.
 * (The terms wiring itself fails open to legacy wording; billing deliberately does not.)
 */
export async function getHoldoverClauseStatus(admin: SupabaseClient): Promise<HoldoverClauseStatus> {
  try {
    const clause = await admin.from("vo_clauses").select("id").eq("code", HOLDOVER_CLAUSE_CODE).maybeSingle();
    if (clause.error) {
      return { approved: false, reason: NOT_MIGRATED.has(clause.error.code ?? "") ? "not_migrated" : "lookup_failed" };
    }
    if (!clause.data) return { approved: false, reason: "no_current_version" };

    const version = await admin
      .from("vo_clause_versions")
      .select("approved_at")
      .eq("clause_id", clause.data.id)
      .eq("is_current", true)
      .maybeSingle();
    if (version.error) {
      return { approved: false, reason: NOT_MIGRATED.has(version.error.code ?? "") ? "not_migrated" : "lookup_failed" };
    }
    if (!version.data) return { approved: false, reason: "no_current_version" };
    return version.data.approved_at ? { approved: true } : { approved: false, reason: "not_approved" };
  } catch {
    return { approved: false, reason: "lookup_failed" };
  }
}

export async function isHoldoverClauseApproved(admin: SupabaseClient): Promise<boolean> {
  return (await getHoldoverClauseStatus(admin)).approved;
}

/** Plain-words reason for ops, shown in the cron result. Carries no customer data. */
export function holdoverClauseBlockReason(status: HoldoverClauseStatus): string | null {
  if (status.approved) return null;
  switch (status.reason) {
    case "not_migrated":
      return "terms library is not migrated yet (migration 00679); approve the holdover clause T13 in Admin > Terms library after it is";
    case "no_current_version":
      return "the holdover clause T13 has no current version in the terms library";
    case "not_approved":
      return "the current version of the holdover clause T13 has not been approved by legal; approve it in Admin > Terms library";
    default:
      return "the holdover clause approval could not be checked; will retry on the next run";
  }
}
