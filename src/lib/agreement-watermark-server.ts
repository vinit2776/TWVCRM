import type { SupabaseClient } from "@supabase/supabase-js";
import { watermarkPolicy, type WatermarkPolicy, type WatermarkPolicyCase } from "@/lib/agreement-watermark-policy";
import { isDraftAgreement } from "@/lib/draft-watermark";

/**
 * Resolves the watermark policy against live data, for whichever action is
 * about to hand a PDF over.
 *
 * Every path — view, download, send — decides here rather than trusting what
 * the client asked for. The checkbox is a request; this is the answer.
 */
export interface WatermarkDecision extends WatermarkPolicy {
  /** What the caller must actually do. */
  applyWatermark: boolean;
  /** Set when the caller asked for a clean copy it may not have. */
  refused: string | null;
}

/** Is there a settled vo_case invoice for this case? */
export async function hasPaidCaseInvoice(
  admin: SupabaseClient,
  caseId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("billing_statements")
    .select("id")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_case")
    .eq("payment_status", "paid")
    .neq("status", "voided")
    .limit(1);

  // Treat an unreadable answer as unpaid. Failing open here would release a
  // clean agreement on a network blip, which is the one outcome the lock
  // exists to prevent.
  if (error) {
    console.error(`[watermark] payment lookup failed for case ${caseId}: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function resolveWatermark(args: {
  admin: SupabaseClient;
  caseId: string;
  caseRow: WatermarkPolicyCase;
  agreement: { status?: string | null; signed_document_id?: string | null; stamp_reference?: string | null };
  /** What the caller asked for; undefined means "use the default", which is on. */
  requestedClean?: boolean;
}): Promise<WatermarkDecision> {
  const isDraft = isDraftAgreement(args.agreement);
  const hasPaidInvoice = isDraft ? await hasPaidCaseInvoice(args.admin, args.caseId) : false;
  const policy = watermarkPolicy({ case: args.caseRow, hasPaidInvoice, isDraft });

  // An executed agreement is never watermarked, whatever anyone asked for.
  if (policy.settled) {
    return { ...policy, applyWatermark: false, refused: null };
  }

  if (args.requestedClean && policy.forced) {
    return {
      ...policy,
      applyWatermark: true,
      refused: policy.reason,
    };
  }

  return {
    ...policy,
    applyWatermark: !args.requestedClean,
    refused: null,
  };
}
