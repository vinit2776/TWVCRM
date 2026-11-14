import type { SupabaseClient } from "@supabase/supabase-js";
import { getCachedSetting } from "@/lib/app-settings-cache";

/**
 * Gate on handing a watermarked DRAFT Leave & License agreement to a customer
 * before payment. Signing, stamp and seal, and the clean copy are NOT governed
 * here: they stay locked until payment in full (vo-execution-gate.ts and
 * agreement-watermark-policy.ts).
 *
 * Mode comes from app_settings.vo_draft_gate_mode:
 *   'off'     (default) today's behaviour, no extra requirement
 *   'enforce' the draft may go out only once the customer has accepted and the
 *             signer's KYC has been reviewed
 */
export type DraftGateMode = "off" | "enforce";

export const DRAFT_SEND_ROLES = ["admin", "manager", "sales_rep"] as const;

export function parseDraftGateMode(raw: string | null | undefined): DraftGateMode {
  return raw === "enforce" ? "enforce" : "off";
}

export interface DraftSendGateInput {
  accepted: boolean;
  /** true / false, or null when it cannot be enforced yet (column missing). */
  kycReviewed: boolean | null;
  role: string | null | undefined;
  mode: DraftGateMode;
}

export function draftSendGate(input: DraftSendGateInput): { allowed: boolean; reason: string | null } {
  if (input.mode !== "enforce") return { allowed: true, reason: null };

  if (!input.role || !(DRAFT_SEND_ROLES as readonly string[]).includes(input.role)) {
    return { allowed: false, reason: "Your role cannot send agreement drafts." };
  }
  if (!input.accepted) {
    return {
      allowed: false,
      reason: "The draft can go to the customer only after they have accepted the case terms.",
    };
  }
  // null means the KYC-review column does not exist yet: not enforceable, so allowed.
  if (input.kycReviewed === false) {
    return {
      allowed: false,
      reason: "The signer's KYC must be reviewed before the draft can go to the customer.",
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Customer acceptance signal for a VO case.
 *
 * Acceptance is recorded in two places that move together: the Leave & License
 * agreement row reaches 'client_approved' (agreement PATCH action
 * client_approved) and the case workflow reaches 'client_approved'
 * (case-workflow.ts). Either, or any later state of either, counts. The linked
 * proposal is deliberately not used: VO cases are not proposal-driven.
 */
const ACCEPTED_AGREEMENT_STATUSES = ["client_approved", "signing", "executed"];
const ACCEPTED_CASE_STATUSES = [
  "client_approved",
  "signing_in_progress",
  "executed",
  "invoiced",
  "active",
  "renewal_due",
  "renewed",
];

export function isCustomerAccepted(args: {
  caseStatus?: string | null;
  agreementStatus?: string | null;
}): boolean {
  return (
    ACCEPTED_AGREEMENT_STATUSES.includes(args.agreementStatus ?? "") ||
    ACCEPTED_CASE_STATUSES.includes(args.caseStatus ?? "")
  );
}

/** Postgres undefined_column: the migration adding the column has not run. */
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703";
}

/**
 * cases.kyc_reviewed_at is added by a parallel PR. Returns null when the column
 * does not exist (or the read failed for that reason), meaning not enforceable.
 */
export async function loadKycReviewed(admin: SupabaseClient, caseId: string): Promise<boolean | null> {
  const { data, error } = await admin
    .from("cases")
    .select("kyc_reviewed_at")
    .eq("id", caseId)
    .maybeSingle();
  if (error) {
    if (!isMissingColumn(error)) {
      console.error(`[vo-draft-gate] kyc lookup failed for case ${caseId}: ${error.message}`);
      return false;
    }
    return null;
  }
  return !!(data as { kyc_reviewed_at?: string | null } | null)?.kyc_reviewed_at;
}

/** Runs the gate against live data. Cheap no-op when the mode is 'off'. */
export async function evaluateDraftSendGate(args: {
  admin: SupabaseClient;
  caseId: string;
  role: string | null | undefined;
  agreementStatus?: string | null;
}): Promise<{ allowed: boolean; reason: string | null }> {
  const mode = parseDraftGateMode(await getCachedSetting(args.admin, "vo_draft_gate_mode"));
  if (mode !== "enforce") return { allowed: true, reason: null };

  const { data: caseRow } = await args.admin
    .from("cases").select("status").eq("id", args.caseId).maybeSingle();
  return draftSendGate({
    accepted: isCustomerAccepted({
      caseStatus: (caseRow as { status?: string | null } | null)?.status,
      agreementStatus: args.agreementStatus,
    }),
    kycReviewed: await loadKycReviewed(args.admin, args.caseId),
    role: args.role,
    mode,
  });
}
