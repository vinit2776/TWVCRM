import type { Flag } from "@/lib/vo-kyc-validators";
import { KYC_PORTAL_CHECK_TYPES } from "@/lib/constants";

/**
 * Two-step KYC review for Virtual Office cases. Pure logic only.
 *
 * Step 1 (preparer): run the automatic flags and record what the government
 * portals showed. Step 2 (manager): sign off. Flags are a warning, never a block,
 * but the reviewer must answer every one of them with a reason before the case
 * counts as KYC-reviewed.
 */

export const KYC_PREPARE_ROLES = ["admin", "manager", "sales_rep"];
export const KYC_SIGNOFF_ROLES = ["admin", "manager"];
export const KYC_ACK_REASON_MIN_LENGTH = 10;

export type PortalCheckType = (typeof KYC_PORTAL_CHECK_TYPES)[number];

export interface PortalCheck {
  check_type: string;
  result: string;
  evidence_note: string | null;
  checked_at: string;
}

export interface FlagAck {
  code: string;
  reason: string;
}

export function canPrepareKyc(role: string): boolean {
  return KYC_PREPARE_ROLES.includes(role);
}

export function canSignOffKyc(role: string): boolean {
  return KYC_SIGNOFF_ROLES.includes(role);
}

/** Flags the reviewer has to answer. "ok" and "info" need no acknowledgement. */
export function flagsNeedingAck(flags: Flag[]): Flag[] {
  return flags.filter((f) => f.severity === "warning" || f.severity === "serious");
}

/** A portal result that is not a clean match is a warning in its own right. */
export function portalCheckWarnings(checks: PortalCheck[]): Flag[] {
  return latestPortalChecks(checks)
    .filter((c) => c.result !== "matched")
    .map((c) => ({
      code: `portal_${c.check_type}`,
      severity: "warning" as const,
      field: c.check_type,
      message: `Portal check "${c.check_type}" came back as ${c.result.replace("_", " ")}.`,
    }));
}

/** Newest record per check type (checks are kept as history). */
export function latestPortalChecks(checks: PortalCheck[]): PortalCheck[] {
  const byType = new Map<string, PortalCheck>();
  for (const c of checks) {
    const prev = byType.get(c.check_type);
    if (!prev || c.checked_at > prev.checked_at) byType.set(c.check_type, c);
  }
  return [...byType.values()];
}

/** Everything the sign-off has to answer: auto flags plus bad portal results. */
export function allWarnings(flags: Flag[], checks: PortalCheck[]): Flag[] {
  return [...flagsNeedingAck(flags), ...portalCheckWarnings(checks)];
}

export interface PortalCheckInput {
  check_type: string;
  result: string;
  evidence_note?: string | null;
}

/** A result other than "matched" needs a note saying what was seen. */
export function validatePortalCheck(input: PortalCheckInput): string | null {
  if (!(KYC_PORTAL_CHECK_TYPES as readonly string[]).includes(input.check_type)) {
    return `Unknown check type: ${input.check_type}`;
  }
  if (input.result !== "matched" && !(input.evidence_note ?? "").trim()) {
    return "Add a note about what the portal showed";
  }
  return null;
}

export type KycStep = "not_started" | "awaiting_signoff" | "reviewed";

export interface KycReviewSnapshot {
  checksRunAt: string | null;
  reviewedAt: string | null;
  flags: Flag[];
  portalChecks: PortalCheck[];
}

export function kycStep(s: KycReviewSnapshot): KycStep {
  if (!s.checksRunAt) return "not_started";
  return s.reviewedAt ? "reviewed" : "awaiting_signoff";
}

export interface SignoffCheck {
  ok: boolean;
  /** Warning codes still without an acknowledgement and reason. */
  missing: string[];
  error: string | null;
}

/**
 * Can the manager sign off with these acknowledgements? Step 1 must be done,
 * and every warning must carry a reason of its own. Extra acknowledgements for
 * codes that are not warnings are ignored.
 */
export function checkSignoff(s: KycReviewSnapshot, acks: FlagAck[]): SignoffCheck {
  if (!s.checksRunAt) {
    return { ok: false, missing: [], error: "Run the checks (step 1) before signing off" };
  }
  const answered = new Set(
    acks.filter((a) => a.reason.trim().length >= KYC_ACK_REASON_MIN_LENGTH).map((a) => a.code),
  );
  const missing = allWarnings(s.flags, s.portalChecks)
    .map((f) => f.code)
    .filter((code) => !answered.has(code));
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      error: `Acknowledge each warning with a reason of at least ${KYC_ACK_REASON_MIN_LENGTH} characters`,
    };
  }
  return { ok: true, missing: [], error: null };
}

/** Keep only the acknowledgements that answer a current warning, trimmed. */
export function relevantAcks(s: KycReviewSnapshot, acks: FlagAck[]): FlagAck[] {
  const codes = new Set(allWarnings(s.flags, s.portalChecks).map((f) => f.code));
  return acks
    .filter((a) => codes.has(a.code))
    .map((a) => ({ code: a.code, reason: a.reason.trim() }));
}
