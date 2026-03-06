/**
 * Leegality E-Sign & E-Stamp Integration
 *
 * Leegality is used for:
 * - E-stamp paper (via BharatStamp for Tamil Nadu and 30 other states)
 * - Aadhaar eSign / VirtualSign-based digital signing
 * - Multi-party signing workflows
 *
 * API Reference: https://github.com/prakharmittal/leegality-apidocs/blob/master/api_3_0.json
 * Endpoint: POST https://api.leegality.com/v3.0/sign/request
 * Auth: X-Auth-Token header
 *
 * Key concepts:
 *   - profileId: Workflow ID from Leegality Dashboard (REQUIRED, set via LEEGALITY_PROFILE_ID)
 *   - inviteetype: signing method per invitee ("AADHAAR", "VIRTUAL", "DSC", "OFFLINE_SIGN")
 *   - stampSeries: stamp series code from dashboard (set via LEEGALITY_STAMP_SERIES)
 *   - stampValue: stamp duty amount as string e.g. "300"
 *   - documentId + signUrl returned on successful upload
 *
 * Webhook HMAC: LEEGALITY_PRIVATE_SALT — used to verify inbound webhook signatures
 */

import crypto from "crypto";

// ================================================================
// Types
// ================================================================

export interface LeegalityUploadResponse {
  /** Leegality document ID */
  documentId: string;
  /** URL for the signer to complete signing (may be first invitee's URL) */
  signUrl: string;
  /** All signing URLs indexed by invitee (raw array from API) */
  signUrls: string[];
  /** Current status */
  status: "CREATED" | "IN_PROGRESS" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  /** E-stamp duty paid (if returned by API) */
  stampDutyPaid?: number;
  /** Expiry date of the signing request */
  expiresAt: string;
}

export interface LeegalitySigningStatus {
  /** Leegality document ID */
  documentId: string;
  /** Current status */
  status: "CREATED" | "IN_PROGRESS" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  /** Signer details */
  signers: {
    name: string;
    email: string;
    phone?: string;
    status: "PENDING" | "SIGNED" | "EXPIRED";
    signedAt?: string;
    signMethod?: "aadhaar_esign" | "dsc" | "electronic";
  }[];
  /** E-stamp details */
  eStamp?: {
    state: string;
    value: number;
    certificateNumber?: string;
    stampedAt?: string;
  };
  /** Last updated */
  updatedAt: string;
}

export interface LeegalityDownloadResult {
  /** Base64 encoded signed + stamped PDF */
  pdfBase64: string;
  /** File name */
  fileName: string;
}

// ================================================================
// Config
// ================================================================

// Leegality API v3.0 base URL — endpoint is /sign/request
const BASE_URL =
  process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3.0";
const API_KEY = process.env.LEEGALITY_API_KEY;
const PROFILE_ID = process.env.LEEGALITY_PROFILE_ID;
const STAMP_SERIES = process.env.LEEGALITY_STAMP_SERIES;
const IS_SANDBOX = process.env.LEEGALITY_ENVIRONMENT !== "production";

function getAuthHeaders() {
  return {
    "X-Auth-Token": API_KEY!,
    "Content-Type": "application/json",
  };
}

// ================================================================
// Upload document for e-stamping and e-signing
// ================================================================

/**
 * Upload a PDF to Leegality for e-stamping and signing.
 * Uses multi-party signing with sequential order:
 *   1. Lessor (TWV) — signs first (VirtualSign / electronic)
 *   2. Lessee (client) — signs second (Aadhaar eSign)
 *
 * Requires LEEGALITY_PROFILE_ID env var — get this from your Leegality Dashboard
 * under Settings → Workflows/Profiles.
 */
export async function uploadForEStampAndSigning(params: {
  /** PDF file as Buffer */
  pdfBuffer: Buffer;
  /** Document title */
  documentName: string;
  /** Lessor (TWV) signer details */
  lessorSigner: {
    name: string;
    email: string;
    phone: string;
  };
  /** Lessee (client) signer details */
  lesseeSigner: {
    name: string;
    email: string;
    phone: string;
    signMethod?: "aadhaar_esign" | "dsc" | "electronic";
  };
  /** Expiry in days (default 30) */
  expiryDays?: number;
}): Promise<LeegalityUploadResponse> {
  if (!API_KEY) {
    console.warn("[Leegality] No API key configured — returning mock response.");
    return createMockUploadResponse(params.documentName);
  }

  if (!PROFILE_ID) {
    console.warn(
      "[Leegality] LEEGALITY_PROFILE_ID is not configured — sending request without profileId. " +
        "The API will use inline invitee configuration."
    );
  }

  // Map signing method to Leegality inviteetype
  const lesseeInviteeType =
    params.lesseeSigner.signMethod === "dsc"
      ? "OFFLINE_SIGN"
      : params.lesseeSigner.signMethod === "electronic"
        ? "VIRTUAL"
        : "AADHAAR"; // default: Aadhaar eSign

  const body: Record<string, unknown> = {
    ...(PROFILE_ID ? { profileId: PROFILE_ID } : {}),
    file: {
      name: `${params.documentName}.pdf`,
      // Leegality API expects base64 in the "file" field (not "data")
      file: params.pdfBuffer.toString("base64"),
    },
    invitees: [
      {
        name: params.lessorSigner.name,
        email: params.lessorSigner.email,
        phone: params.lessorSigner.phone,
        // Lessor signs electronically (VirtualSign)
        inviteetype: "VIRTUAL",
      },
      {
        name: params.lesseeSigner.name,
        email: params.lesseeSigner.email,
        phone: params.lesseeSigner.phone,
        // Lessee signs via Aadhaar OTP eSign by default
        inviteetype: lesseeInviteeType,
      },
    ],
  };

  // Optional: add internal reference number for traceability
  body.irn = `TWV-${Date.now()}`;

  const response = await fetch(`${BASE_URL}/sign/request`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Leegality upload failed [${response.status}]: ${errText}`
    );
  }

  const data = await response.json();

  // signUrl may be a string or array depending on API version/response
  const signUrlRaw = data.signUrl ?? data.signing_url ?? data.sign_url;
  const signUrls: string[] = Array.isArray(signUrlRaw)
    ? signUrlRaw
    : signUrlRaw
      ? [signUrlRaw]
      : [];
  // Return the first invitee's (lessor's) sign URL so TWV can sign first
  const signUrl = signUrls[0] ?? "";

  return {
    documentId: data.documentId ?? data.document_id ?? data.id ?? "",
    signUrl,
    signUrls,
    status: normalizeStatus(data.status ?? "CREATED"),
    stampDutyPaid: data.stampValue ? Number(data.stampValue) : data.stamp_duty_amount ? Number(data.stamp_duty_amount) : undefined,
    expiresAt:
      data.expiresAt ??
      data.expires_at ??
      data.expiry_date ??
      new Date(
        Date.now() + (params.expiryDays ?? 30) * 86400000
      ).toISOString(),
  };
}

// ================================================================
// Get signing / stamping status
// ================================================================

/**
 * Get the current signing/stamping status of a Leegality document.
 * Uses GET /v3.0/sign/request?documentId=...
 */
export async function getSigningStatus(
  documentId: string
): Promise<LeegalitySigningStatus> {
  if (!API_KEY) {
    console.warn("[Leegality] No API key configured — returning mock status.");
    return createMockSigningStatus(documentId);
  }

  const response = await fetch(
    `${BASE_URL}/sign/request?documentId=${encodeURIComponent(documentId)}`,
    {
      method: "GET",
      headers: getAuthHeaders(),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Leegality status check failed [${response.status}]: ${errText}`
    );
  }

  const data = await response.json();

  return {
    documentId: data.documentId ?? data.document_id ?? data.id ?? documentId,
    status: normalizeStatus(data.status ?? ""),
    signers: (data.invitees ?? data.signers ?? data.inviteees ?? []).map(
      (s: Record<string, unknown>) => ({
        name: String(s.name ?? ""),
        email: String(s.email ?? ""),
        phone: s.phone ? String(s.phone) : undefined,
        status: normalizeSignerStatus(String(s.status ?? "")),
        signedAt: s.signedAt
          ? String(s.signedAt)
          : s.signed_at
            ? String(s.signed_at)
            : undefined,
        signMethod: s.inviteetype
          ? mapInviteeType(String(s.inviteetype))
          : s.sign_type
            ? mapSignType(String(s.sign_type))
            : undefined,
      })
    ),
    eStamp: (data.stampDetails ?? data.stamp_paper)
      ? {
          state: String(
            (data.stampDetails ?? data.stamp_paper)?.state ?? ""
          ),
          value: Number(
            (data.stampDetails ?? data.stamp_paper)?.stampValue ??
              (data.stampDetails ?? data.stamp_paper)?.stamp_duty_amount ??
              0
          ),
          certificateNumber: (data.stampDetails ?? data.stamp_paper)
            ?.certificateNumber
            ? String(
                (data.stampDetails ?? data.stamp_paper).certificateNumber
              )
            : undefined,
          stampedAt: (data.stampDetails ?? data.stamp_paper)?.stampedAt
            ? String((data.stampDetails ?? data.stamp_paper).stampedAt)
            : undefined,
        }
      : undefined,
    updatedAt: String(
      data.updatedAt ??
        data.updated_at ??
        data.modified_at ??
        new Date().toISOString()
    ),
  };
}

// ================================================================
// Download the signed + stamped PDF
// ================================================================

/**
 * Download the signed and e-stamped document from Leegality.
 * Returns the PDF as a base64 string.
 */
export async function downloadStampedDocument(
  documentId: string
): Promise<LeegalityDownloadResult> {
  if (!API_KEY) {
    console.warn("[Leegality] No API key configured — returning empty download.");
    return {
      pdfBase64: "",
      fileName: `stamped-signed-${documentId}.pdf`,
    };
  }

  // Try v3.0 download endpoint; fall back gracefully
  const response = await fetch(
    `${BASE_URL}/sign/request/document?documentId=${encodeURIComponent(documentId)}`,
    {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY,
        Accept: "application/pdf",
      },
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Leegality download failed [${response.status}]: ${errText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Leegality may return raw binary or JSON-wrapped base64
  if (contentType.includes("application/json")) {
    const data = await response.json();
    const b64 = data.file_data ?? data.data ?? data.file ?? "";
    return {
      pdfBase64: b64,
      fileName: `stamped-signed-${documentId}.pdf`,
    };
  }

  // Binary PDF
  const arrayBuffer = await response.arrayBuffer();
  return {
    pdfBase64: Buffer.from(arrayBuffer).toString("base64"),
    fileName: `stamped-signed-${documentId}.pdf`,
  };
}

// ================================================================
// Webhook signature verification
// ================================================================

/**
 * Verify the HMAC signature of an inbound Leegality webhook.
 *
 * Leegality signs the raw request body with HMAC-SHA256 using the
 * LEEGALITY_PRIVATE_SALT and sends the hex digest in the
 * X-Leegality-Signature header.
 *
 * @param rawBody   Raw request body string (do NOT parse JSON first)
 * @param signature Value of the X-Leegality-Signature header
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  const salt = process.env.LEEGALITY_PRIVATE_SALT;
  if (!salt) {
    console.warn("[Leegality] LEEGALITY_PRIVATE_SALT not set — skipping verification.");
    return true; // allow through in dev if salt not set
  }
  const expected = crypto
    .createHmac("sha256", salt)
    .update(rawBody)
    .digest("hex");
  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

// ================================================================
// Helpers
// ================================================================

type LeegalityStatus = LeegalityUploadResponse["status"];

function normalizeStatus(raw: string): LeegalityStatus {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "CREATED") return "CREATED";
  if (
    upper === "IN_PROGRESS" ||
    upper === "INPROGRESS" ||
    upper === "PENDING" ||
    upper === "SENT"
  )
    return "IN_PROGRESS";
  if (
    upper === "COMPLETED" ||
    upper === "DONE" ||
    upper === "SIGNED" ||
    upper === "COMPLETE"
  )
    return "COMPLETED";
  if (upper === "EXPIRED") return "EXPIRED";
  if (upper === "CANCELLED" || upper === "CANCELED") return "CANCELLED";
  return "IN_PROGRESS";
}

function normalizeSignerStatus(raw: string): "PENDING" | "SIGNED" | "EXPIRED" {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "SIGNED" || upper === "COMPLETED" || upper === "DONE" || upper === "COMPLETE")
    return "SIGNED";
  if (upper === "EXPIRED") return "EXPIRED";
  return "PENDING";
}

function mapInviteeType(raw: string): "aadhaar_esign" | "dsc" | "electronic" {
  const upper = raw.toUpperCase();
  if (upper === "AADHAAR" || upper === "AADHAAR_ESIGN") return "aadhaar_esign";
  if (upper === "DSC" || upper === "OFFLINE_SIGN") return "dsc";
  return "electronic";
}

function mapSignType(raw: string): "aadhaar_esign" | "dsc" | "electronic" {
  if (raw === "aadhaar" || raw === "aadhaar_esign") return "aadhaar_esign";
  if (raw === "dsc") return "dsc";
  return "electronic";
}

// ================================================================
// Mock Helpers (used in dev when LEEGALITY_API_KEY is not set)
// ================================================================

function createMockUploadResponse(
  documentName: string
): LeegalityUploadResponse {
  const mockId = `LEG${Date.now().toString(36).toUpperCase()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  const mockSignUrl = IS_SANDBOX
    ? `https://sandbox.leegality.com/sign/${mockId}`
    : `https://app.leegality.com/sign/${mockId}`;

  return {
    documentId: mockId,
    signUrl: mockSignUrl,
    signUrls: [mockSignUrl],
    status: "CREATED",
    expiresAt: expiresAt.toISOString(),
  };
}

function createMockSigningStatus(documentId: string): LeegalitySigningStatus {
  return {
    documentId,
    status: "IN_PROGRESS",
    signers: [
      {
        name: "Naval Chordia",
        email: "naval@theworkvilla.com",
        status: "SIGNED",
        signMethod: "electronic",
        signedAt: new Date().toISOString(),
      },
      {
        name: "Mock Client",
        email: "client@example.com",
        status: "PENDING",
        signMethod: "aadhaar_esign",
      },
    ],
    eStamp: {
      state: "Tamil Nadu",
      value: 300,
      certificateNumber: `TN-MOCK-${documentId}`,
      stampedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}
