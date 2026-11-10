import type { SupabaseClient } from "@supabase/supabase-js";
import { caseClauseGateError } from "@/lib/special-clause/case-gate";
import { ADDRESS_STALE_REASON, agreementAddressGate, agreementAddressIsStale, caseAddressText } from "@/lib/agreement-address-gate";

/** Reason a case agreement can't be sent, signed or executed right now (client
 *  address missing from the stored agreement or out of step with the case, or
 *  special-clause problem); null when it may proceed. Callers return it as a 409. Checks the stored
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
  const { data: kase } = await supabase
    .from("cases")
    .select("client_address, client_city, client_state, client_pincode")
    .eq("id", caseId)
    .maybeSingle();
  if (kase && agreementAddressIsStale(caseAddressText(kase), typeof vars.client_address === "string" ? vars.client_address : null)) {
    return ADDRESS_STALE_REASON;
  }
  return caseClauseGateError(supabase, caseId, agreementId);
}
