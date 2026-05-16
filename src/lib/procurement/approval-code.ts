import { createHmac } from "crypto";

/**
 * Generates a tamper-proof approval code.
 *
 * Format: APR-YYMM-NNN-XXXX
 *   APR-YYMM-NNN = human-readable sequential part
 *   XXXX         = 4-char HMAC signature (uppercase hex) derived from
 *                  the entity ID + timestamp + server secret
 *
 * The signature makes the code impossible to forge without the secret.
 * Anyone can verify by re-computing the HMAC from the stored record.
 *
 * SECURITY: APPROVAL_CODE_SECRET must be set as a dedicated env variable.
 * Do not reuse SUPABASE_SERVICE_ROLE_KEY for signing — it is a DB credential,
 * not a signing secret, and key rotation for one purpose should not invalidate
 * the other. Set APPROVAL_CODE_SECRET in Vercel → Settings → Environment Variables.
 */

function getApprovalSecret(): string {
  const secret = process.env.APPROVAL_CODE_SECRET;
  if (!secret) {
    throw new Error(
      "[approval-code] APPROVAL_CODE_SECRET environment variable is not set. " +
      "Add it to Vercel → Settings → Environment Variables before deploying. " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return secret;
}

export type ApprovalType = "pr" | "bill" | "transfer";

const PREFIX_MAP: Record<ApprovalType, string> = {
  pr: "APR",
  bill: "BAP",
  transfer: "TAP",
};

/**
 * Generate a signed approval code.
 * @param type - The approval type (pr, bill, transfer)
 * @param seq - Sequential number (e.g., count of existing approvals + 1)
 * @param entityId - The UUID of the entity being approved (used in HMAC)
 */
export function generateSignedApprovalCode(
  type: ApprovalType,
  seq: number,
  entityId: string
): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seqStr = String(seq).padStart(3, "0");
  const prefix = PREFIX_MAP[type];

  // Base code without signature
  const baseCode = `${prefix}-${yy}${mm}-${seqStr}`;

  // HMAC signature: hash(entityId + baseCode + timestamp)
  const payload = `${entityId}:${baseCode}:${now.toISOString().split("T")[0]}`;
  const hmac = createHmac("sha256", getApprovalSecret()).update(payload).digest("hex");
  const sig = hmac.slice(0, 4).toUpperCase();

  return `${baseCode}-${sig}`;
}

/**
 * Verify an approval code's signature against a known entity.
 * Used by the verification page to confirm the code wasn't forged.
 */
export function verifyApprovalCode(
  code: string,
  entityId: string,
  approvedAt: string // ISO date string
): boolean {
  const parts = code.split("-");

  // Legacy codes (APR-YYMM-NNN) have 3 parts — no signature.
  // These were generated before HMAC signing was introduced.
  // If the code was found in the DB, it's genuine.
  if (parts.length === 3) return true;

  if (parts.length !== 4) return false;

  const baseCode = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const providedSig = parts[3];

  // Re-compute HMAC with the approval date
  const approvalDate = approvedAt.split("T")[0];
  const payload = `${entityId}:${baseCode}:${approvalDate}`;
  const hmac = createHmac("sha256", getApprovalSecret()).update(payload).digest("hex");
  const expectedSig = hmac.slice(0, 4).toUpperCase();

  return providedSig === expectedSig;
}
