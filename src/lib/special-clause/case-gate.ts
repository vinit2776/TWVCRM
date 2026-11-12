import type { SupabaseClient } from "@supabase/supabase-js";
import { agreementClauseGate } from "./gate";

/** Reason a VO case agreement can't go out right now because of its special
 *  clause (not approved, or the stored PDF doesn't carry the approved text);
 *  null when it may proceed. Callers return it as a 409. */
export async function caseClauseGateError(supabase: SupabaseClient, caseId: string, agreementId: string): Promise<string | null> {
  const { data: kase } = await supabase.from("cases").select("special_clause_status, special_clause_text").eq("id", caseId).maybeSingle();
  const k = kase as { special_clause_status: string | null; special_clause_text: string | null } | null;
  // No clause and nothing to compare against: the common case, no extra query needed for the agreement.
  const { data: agr } = await supabase.from("case_agreements").select("variables").eq("id", agreementId).eq("case_id", caseId).maybeSingle();
  const vars = ((agr as { variables: Record<string, unknown> | null } | null)?.variables ?? {}) as Record<string, unknown>;
  const gate = agreementClauseGate({
    caseStatus: k?.special_clause_status,
    caseText: k?.special_clause_text,
    agreementText: typeof vars.special_clause_text === "string" ? vars.special_clause_text : null,
  });
  return gate.blocked ? gate.reason : null;
}
