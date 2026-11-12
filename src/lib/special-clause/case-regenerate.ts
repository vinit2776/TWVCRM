import type { SupabaseClient } from "@supabase/supabase-js";
import { generateAgreementPdf, type AgreementTemplateKey, type AgreementVariables } from "@/lib/agreement-generator";
import { generateLeaveLicensePdf, type LeaveLicenseVariables } from "@/lib/leave-license-generator";
import { caseAddressText } from "@/lib/agreement-address-gate";

// A VO case's agreements are stored PDFs built from `variables`. When the
// case's approved clause or client address changes, rebuild every agreement that
// hasn't gone out yet so the stored copy matches. Agreements already sent/signed are left
// alone; submit/withdraw refuse to change a clause once one is out for signature.
// Failures are logged, not thrown: agreementClauseGate then blocks sending a
// stale PDF, so the safe state holds even when this step doesn't complete.

const REGENERABLE = ["draft", "internally_approved"];
const norm = (t: unknown) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "");

export async function regenerateCaseAgreementPdfs(admin: SupabaseClient, caseId: string): Promise<void> {
  const { data: kase } = await admin
    .from("cases")
    .select("special_clause_status, special_clause_text, client_address, client_city, client_state, client_pincode")
    .eq("id", caseId).maybeSingle();
  const k = kase as {
    special_clause_status: string | null; special_clause_text: string | null;
    client_address: string | null; client_city: string | null; client_state: string | null; client_pincode: string | null;
  } | null;
  if (!k) return;
  const text = k.special_clause_status === "approved" ? k.special_clause_text : null;
  // One source for the address: the case. An empty case address leaves the agreement's as is.
  const address = caseAddressText(k);

  const { data: agreements } = await admin
    .from("case_agreements").select("id, type, template_key, variables, status")
    .eq("case_id", caseId).in("status", REGENERABLE);

  for (const a of (agreements ?? []) as { id: string; type: string; template_key: string; variables: Record<string, unknown> | null }[]) {
    try {
      const vars = { ...(a.variables ?? {}), special_clause_text: text } as Record<string, unknown>;
      if (address) vars.client_address = address;
      const clauseSame = norm(a.variables?.special_clause_text) === norm(text);
      const addressSame = !address || norm(a.variables?.client_address) === norm(address);
      if (clauseSame && addressSame) continue;

      const docId = await writeAgreementPdf(admin, caseId, a, vars);
      // Content changed, so any internal approval no longer covers it (same as editing variables).
      const { error: updErr } = await admin.from("case_agreements")
        .update({ variables: vars, generated_document_id: docId, status: "draft" })
        .eq("id", a.id);
      if (updErr) throw new Error(`agreement: ${updErr.message}`);
      await admin.from("cases").update(a.type === "leave_license" ? { ll_agreement_status: "draft" } : { agreement_status: "draft" }).eq("id", caseId);
    } catch (err) {
      console.error(`[special-clause] couldn't regenerate agreement ${a.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Builds the agreement PDF from `vars`, stores it and records a documents row.
 *  `parentDocumentId` chains it to the document it supersedes (version history).
 *  Returns the new document's id; throws on any failure. */
export async function writeAgreementPdf(
  admin: SupabaseClient,
  caseId: string,
  a: { type: string; template_key: string },
  vars: Record<string, unknown>,
  parentDocumentId?: string | null,
): Promise<string> {
  const isLl = a.type === "leave_license";
  const doc = isLl
    ? generateLeaveLicensePdf(vars as unknown as LeaveLicenseVariables)
    : generateAgreementPdf(a.template_key as AgreementTemplateKey, vars as unknown as AgreementVariables);
  const buffer = Buffer.from(doc.output("arraybuffer"));
  const path = `case-agreements/${caseId}/${Date.now()}-${isLl ? "leave-license" : "proposal"}.pdf`;

  const { error: upErr } = await admin.storage.from("crm-documents").upload(path, buffer, { contentType: "application/pdf", upsert: true });
  if (upErr) throw new Error(`upload: ${upErr.message}`);

  const clientName = String(vars.client_company_name || vars.client_name || "Client");
  const { data: docRow, error: docErr } = await admin.from("documents").insert({
    title: `${isLl ? "Leave & License Agreement" : "Virtual Office Proposal"} - ${clientName}`,
    file_name: `${isLl ? "leave-license" : "proposal"}-${caseId}.pdf`,
    file_path: path,
    mime_type: "application/pdf",
    size_bytes: buffer.length,
    category: "case_document",
    ...(parentDocumentId ? { parent_document_id: parentDocumentId } : {}),
  }).select("id").single();
  if (docErr || !docRow) throw new Error(`document: ${docErr?.message}`);
  return (docRow as { id: string }).id;
}
