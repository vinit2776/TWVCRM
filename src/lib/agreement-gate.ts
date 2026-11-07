import type { SupabaseClient } from "@supabase/supabase-js";
import { caseClauseGateError } from "@/lib/special-clause/case-gate";
import { agreementAddressGate } from "@/lib/agreement-address-gate";

/** Reason a case agreement can't be sent, signed or executed right now (client
 *  address missing from the stored agreement, or special-clause problem); null
 *  when it may proceed. Callers return it as a 409. Checks the stored
 *  agreement's own address, because that is what the PDF printed. */
export async function caseAgreementGateError(
  supabase: SupabaseClient,
  caseId: string,
  agreementId: string,
): Promise<string | null> {
  const { data: agr } = await supabase
    .from("case_agreements")
    .select("variables")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .maybeSingle();
  const vars = ((agr as { variables: Record<string, unknown> | null } | null)?.variables ?? {}) as Record<string, unknown>;
  const addr = agreementAddressGate(typeof vars.client_address === "string" ? vars.client_address : null);
  if (addr.blocked) return addr.reason;
  return caseClauseGateError(supabase, caseId, agreementId);
}
