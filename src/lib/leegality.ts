/**
 * Leegality E-Sign & E-Stamp Integration (Stub)
 *
 * This module provides stub implementations for the Leegality API.
 * Stubs return mock data until real Leegality credentials are configured.
 *
 * Leegality is used for:
 * - E-stamp paper (via BharatStamp for Tamil Nadu)
 * - Aadhaar eSign / DSC-based digital signing
 * - Multi-party signing workflows
 *
 * API Reference: https://docs.leegality.com
 * Integration: REST API v3 with Workflow ID pattern
 */

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

const IS_SANDBOX = process.env.LEEGALITY_ENVIRONMENT !== "production";

/**
 * Upload a PDF to Leegality for e-stamping and signing.
 * Uses Workflow ID pattern for multi-party signing.
 *
 * STUB: Returns mock data until LEEGALITY_API_KEY is configured.
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
  /** Expiry in days */
  expiryDays?: number;
}): Promise<LeegalityUploadResponse> {
  if (!process.env.LEEGALITY_API_KEY) {
    console.warn("[Leegality Stub] No API key configured. Returning mock response.");
    return createMockUploadResponse(params.documentName, params.stampDutyValue);
  }

  // TODO: Implement real Leegality API call when credentials available
  // const baseUrl = process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3";
  //
  // Step 1: Upload document
  // const uploadRes = await fetch(`${baseUrl}/document/upload`, {
  //   method: "POST",
  //   headers: {
  //     "X-Auth-Token": process.env.LEEGALITY_API_KEY,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     file: { name: params.documentName, data: params.pdfBuffer.toString("base64") },
  //     stamp_paper: {
  //       state: params.stampState,
  //       stamp_duty_amount: params.stampDutyValue,
  //       purchase_stamp_paper: true,
  //     },
  //     signers: [
  //       {
  //         name: params.lessorSigner.name,
  //         email: params.lessorSigner.email,
  //         phone: params.lessorSigner.phone,
  //         sign_type: "aadhaar",
  //         order: 1,
  //       },
  //       {
  //         name: params.lesseeSigner.name,
  //         email: params.lesseeSigner.email,
  //         phone: params.lesseeSigner.phone,
  //         sign_type: params.lesseeSigner.signMethod === "dsc" ? "dsc" : "aadhaar",
  //         order: 2,
  //       },
  //     ],
  //     expire_in_days: params.expiryDays || 30,
  //   }),
  // });
  //
  // const data = await uploadRes.json();
  // return {
  //   documentId: data.document_id,
  //   signUrl: data.signing_url,
  //   status: data.status,
  //   stampDutyPaid: params.stampDutyValue,
  //   expiresAt: data.expires_at,
  // };

  return createMockUploadResponse(params.documentName, params.stampDutyValue);
}

/**
 * Get the current signing/stamping status of a Leegality document.
 *
 * STUB: Returns mock data until LEEGALITY_API_KEY is configured.
 */
export async function getSigningStatus(
  documentId: string
): Promise<LeegalitySigningStatus> {
  if (!process.env.LEEGALITY_API_KEY) {
    console.warn("[Leegality Stub] No API key configured. Returning mock status.");
    return createMockSigningStatus(documentId);
  }

  // TODO: Implement real Leegality API call
  // const baseUrl = process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3";
  // const response = await fetch(`${baseUrl}/document/${documentId}/status`, {
  //   headers: { "X-Auth-Token": process.env.LEEGALITY_API_KEY },
  // });
  // const data = await response.json();
  // return { ... };

  return createMockSigningStatus(documentId);
}

/**
 * Download the signed and e-stamped document from Leegality.
 *
 * STUB: Returns mock data until LEEGALITY_API_KEY is configured.
 */
export async function downloadStampedDocument(
  documentId: string
): Promise<LeegalityDownloadResult> {
  if (!process.env.LEEGALITY_API_KEY) {
    console.warn("[Leegality Stub] No API key configured. Returning mock download.");
    return {
      pdfBase64: "",
      fileName: `stamped-signed-${documentId}.pdf`,
    };
  }

  // TODO: Implement real Leegality API call
  // const baseUrl = process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3";
  // const response = await fetch(`${baseUrl}/document/${documentId}/download`, {
  //   headers: { "X-Auth-Token": process.env.LEEGALITY_API_KEY },
  // });
  // const buffer = await response.arrayBuffer();
  // return { pdfBase64: Buffer.from(buffer).toString("base64"), fileName: `stamped-signed-${documentId}.pdf` };

  return {
    pdfBase64: "",
    fileName: `stamped-signed-${documentId}.pdf`,
  };
}

// ================================================================
// Mock Helpers (for sandbox/development)
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
        name: "Mock Lessor",
        email: "lessor@example.com",
        status: "SIGNED",
        signMethod: "aadhaar_esign",
        signedAt: new Date().toISOString(),
      },
      {
        name: "Mock Lessee",
        email: "lessee@example.com",
        status: "PENDING",
        signMethod: "aadhaar_esign",
      },
    ],
    eStamp: {
      state: "Tamil Nadu",
      value: 100,
      certificateNumber: "TN-MOCK-" + documentId,
      stampedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}
