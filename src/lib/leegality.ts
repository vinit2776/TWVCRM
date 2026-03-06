/**
 * Leegality E-Sign & E-Stamp Integration
 *
 * Leegality is used for:
 * - E-stamp paper (via BharatStamp for Tamil Nadu and 30 other states)
 * - Aadhaar eSign / DSC-based digital signing
 * - Multi-party signing workflows
 *
 * API Reference: https://docs.leegality.com
 * Auth: X-Auth-Token header
 * Base URL: LEEGALITY_API_URL env variable (defaults to https://api.leegality.com/v3)
 * Webhook HMAC: LEEGALITY_PRIVATE_SALT — used to verify inbound webhook signatures
 */

import crypto from "crypto";

// ================================================================
// Types
// ================================================================

export interface LeegalityUploadResponse {
  /** Leegality document ID */
  documentId: string;
  /** URL for the signer to complete signing */
  signUrl: string;
  /** Current status */
  status: "CREATED" | "IN_PROGRESS" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  /** E-stamp duty paid */
  stampDutyPaid: number;
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

const BASE_URL =
  process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3";
const API_KEY = process.env.LEEGALITY_API_KEY;
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
 *   1. Lessor (TWV) — signs first (electronic/aadhaar)
 *   2. Lessee (client) — signs second (aadhaar eSign)
 */
export async function uploadForEStampAndSigning(params: {
  /** PDF file as Buffer */
  pdfBuffer: Buffer;
  /** Document title */
  documentName: string;
  /** E-stamp state (e.g., "Tamil Nadu") */
  stampState: string;
  /** E-stamp duty value in INR */
  stampDutyValue: number;
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
    return createMockUploadResponse(params.documentName, params.stampDutyValue);
  }

  const body = {
    file: {
      name: `${params.documentName}.pdf`,
      data: params.pdfBuffer.toString("base64"),
    },
    stamp_paper: {
      state: params.stampState,
      stamp_duty_amount: params.stampDutyValue,
      purchase_stamp_paper: true,
    },
    signers: [
      {
        name: params.lessorSigner.name,
        email: params.lessorSigner.email,
        phone: params.lessorSigner.phone,
        // Lessor signs electronically (digital signature via Leegality account)
        sign_type: "electronic",
        order: 1,
      },
      {
        name: params.lesseeSigner.name,
        email: params.lesseeSigner.email,
        phone: params.lesseeSigner.phone,
        // Lessee signs via Aadhaar OTP eSign by default
        sign_type:
          params.lesseeSigner.signMethod === "dsc"
            ? "dsc"
            : params.lesseeSigner.signMethod === "electronic"
              ? "electronic"
              : "aadhaar",
        order: 2,
      },
    ],
    expire_in_days: params.expiryDays ?? 30,
    // Webhook URL — Leegality will POST status updates here when signing completes/expires
    ...(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
      ? {
          webhook_url: `${process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/leegality`,
        }
      : {}),
  };

  const response = await fetch(`${BASE_URL}/document/upload`, {
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

  return {
    documentId: data.document_id ?? data.id,
    signUrl: data.signing_url ?? data.sign_url ?? "",
    status: normalizeStatus(data.status),
    stampDutyPaid: data.stamp_duty_amount ?? params.stampDutyValue,
    expiresAt: data.expires_at ?? data.expiry_date ?? new Date(Date.now() + 30 * 86400000).toISOString(),
  };
}

// ================================================================
// Get signing / stamping status
// ================================================================

/**
 * Get the current signing/stamping status of a Leegality document.
 */
export async function getSigningStatus(
  documentId: string
): Promise<LeegalitySigningStatus> {
  if (!API_KEY) {
    console.warn("[Leegality] No API key configured — returning mock status.");
    return createMockSigningStatus(documentId);
  }

  const response = await fetch(`${BASE_URL}/document/${documentId}/status`, {
    method: "GET",
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Leegality status check failed [${response.status}]: ${errText}`
    );
  }

  const data = await response.json();

  return {
    documentId: data.document_id ?? data.id ?? documentId,
    status: normalizeStatus(data.status),
    signers: (data.signers ?? data.invitees ?? []).map(
      (s: Record<string, unknown>) => ({
        name: String(s.name ?? ""),
        email: String(s.email ?? ""),
        phone: s.phone ? String(s.phone) : undefined,
        status: normalizeSignerStatus(String(s.status ?? "")),
        signedAt: s.signed_at ? String(s.signed_at) : undefined,
        signMethod: s.sign_type ? mapSignType(String(s.sign_type)) : undefined,
      })
    ),
    eStamp: data.stamp_paper
      ? {
          state: String(data.stamp_paper.state ?? ""),
          value: Number(data.stamp_paper.stamp_duty_amount ?? 0),
          certificateNumber: data.stamp_paper.certificate_number
            ? String(data.stamp_paper.certificate_number)
            : undefined,
          stampedAt: data.stamp_paper.stamped_at
            ? String(data.stamp_paper.stamped_at)
            : undefined,
        }
      : undefined,
    updatedAt: String(data.updated_at ?? data.modified_at ?? new Date().toISOString()),
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

  const response = await fetch(`${BASE_URL}/document/${documentId}/download`, {
    method: "GET",
    headers: {
      "X-Auth-Token": API_KEY,
      Accept: "application/pdf",
    },
  });

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
    const b64 = data.file_data ?? data.data ?? "";
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
  if (upper === "IN_PROGRESS" || upper === "INPROGRESS" || upper === "PENDING") return "IN_PROGRESS";
  if (upper === "COMPLETED" || upper === "DONE" || upper === "SIGNED") return "COMPLETED";
  if (upper === "EXPIRED") return "EXPIRED";
  if (upper === "CANCELLED" || upper === "CANCELED") return "CANCELLED";
  return "IN_PROGRESS";
}

function normalizeSignerStatus(raw: string): "PENDING" | "SIGNED" | "EXPIRED" {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "SIGNED" || upper === "COMPLETED" || upper === "DONE") return "SIGNED";
  if (upper === "EXPIRED") return "EXPIRED";
  return "PENDING";
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
  documentName: string,
  stampDutyValue: number
): LeegalityUploadResponse {
  const mockId = `LEG${Date.now().toString(36).toUpperCase()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  return {
    documentId: mockId,
    signUrl: IS_SANDBOX
      ? `https://sandbox.leegality.com/sign/${mockId}`
      : `https://app.leegality.com/sign/${mockId}`,
    status: "CREATED",
    stampDutyPaid: stampDutyValue,
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
      value: 100,
      certificateNumber: `TN-MOCK-${documentId}`,
      stampedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}
