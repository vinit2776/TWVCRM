import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAgreementPdf } from "@/lib/special-clause/case-regenerate";
import { cancelSigningRequest } from "@/lib/leegality";

// Changing a case's client address after its agreement is signed (or out for
// e-signature) makes that signature cover the wrong address. The change is only
// applied after a person accepts the warning; the agreement then goes back to a
// draft carrying the new address and must be signed again. The old signed file
// is kept: the new draft's document points at it as its parent.

// Same roles that can send the agreement out again afterwards.
export const AGREEMENT_RESET_ROLES = ["admin", "manager", "sales_rep"];
export const AGREEMENT_RESET_MIN_REASON = 10;
const SIGNED_STATES = ["executed", "signing"];

export interface SignedAgreementRow {
  id: string;
  type: string;
  template_key: string;
  status: string;
  variables: Record<string, unknown> | null;
  generated_document_id: string | null;
  signed_document_id: string | null;
  leegality_document_id: string | null;
}

export async function findSignedAgreements(admin: SupabaseClient, caseId: string): Promise<SignedAgreementRow[]> {
  const { data } = await admin
    .from("case_agreements")
    .select("id, type, template_key, status, variables, generated_document_id, signed_document_id, leegality_document_id")
    .eq("case_id", caseId)
    .in("status", SIGNED_STATES);
  return (data ?? []) as SignedAgreementRow[];
}

/** Withdraws any e-sign request still open at Leegality. Run BEFORE the case is
 *  changed: if it fails the caller aborts, so nothing is half-applied. */
export async function cancelOpenSigningRequests(agreements: SignedAgreementRow[]): Promise<string | null> {
  for (const a of agreements) {
    if (a.status !== "signing" || !a.leegality_document_id) continue;
    try {
      await cancelSigningRequest(a.leegality_document_id);
    } catch (err) {
      console.error(`[agreement-reset] couldn't cancel signing request for agreement ${a.id}:`, err instanceof Error ? err.message : err);
      return "The e-signature request for the current agreement could not be withdrawn, so nothing was changed. Try again, or cancel the signing request from the agreement tab first.";
    }
  }
  return null;
}

/** Rebuilds each signed/signing agreement with the new address as an unsigned
 *  draft. Returns ids it reset; throws nothing, failures are logged and reported. */
export async function resetAgreementsForNewAddress(
  admin: SupabaseClient,
  caseId: string,
  agreements: SignedAgreementRow[],
  address: string,
  reason: string,
): Promise<{ reset: string[]; failed: string[] }> {
  const reset: string[] = [];
  const failed: string[] = [];
  const now = new Date().toISOString();
  for (const a of agreements) {
    try {
      const vars = { ...(a.variables ?? {}), client_address: address, address_reset_at: now, address_reset_reason: reason } as Record<string, unknown>;
      const parent = a.signed_document_id ?? a.generated_document_id;
      const docId = await writeAgreementPdf(admin, caseId, a, vars, parent);
      const { error } = await admin.from("case_agreements").update({
        variables: vars,
        generated_document_id: docId,
        signed_document_id: null,
        signed_at: null,
        status: "draft",
        leegality_status: null,
        leegality_document_id: null,
        leegality_sign_url: null,
      }).eq("id", a.id);
      if (error) throw new Error(error.message);
      await admin.from("cases").update(a.type === "leave_license" ? { ll_agreement_status: "draft" } : { agreement_status: "draft" }).eq("id", caseId);
      reset.push(a.id);
    } catch (err) {
      console.error(`[agreement-reset] couldn't reset agreement ${a.id}:`, err instanceof Error ? err.message : err);
      failed.push(a.id);
    }
  }
  return { reset, failed };
}
