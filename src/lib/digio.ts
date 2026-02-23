/**
 * Digio e-Sign Integration (Stub)
 *
 * This module provides stub implementations for the Digio API.
 * Stubs return mock data until real Digio credentials are configured.
 *
 * Digio is used for Aadhaar OTP-based digital signing of agreements.
 *
 * API Reference: https://docs.digio.in
 */

export interface DigioUploadResponse {
  /** Digio document ID */
  documentId: string;
  /** URL for the signer to complete signing */
  signUrl: string;
  /** Current status of the document */
  status: "CREATED" | "REQUESTED" | "SIGNED" | "EXPIRED" | "CANCELLED";
  /** Expiry date of the signing request */
  expiresAt: string;
}

export interface DigioSigningStatus {
  /** Digio document ID */
  documentId: string;
  /** Current status */
  status: "CREATED" | "REQUESTED" | "SIGNED" | "EXPIRED" | "CANCELLED";
  /** Signer details */
  signers: {
    name: string;
    email: string;
    status: "PENDING" | "SIGNED" | "EXPIRED";
    signedAt?: string;
  }[];
  /** Last updated */
  updatedAt: string;
}

export interface DigioDownloadResult {
  /** Base64 encoded signed PDF */
  pdfBase64: string;
  /** File name */
  fileName: string;
}

const IS_SANDBOX = process.env.DIGIO_ENVIRONMENT !== "production";

/**
 * Upload a document to Digio for e-signing.
 * Returns a signing URL that can be shared with the signer.
 *
 * STUB: Returns mock data until Digio credentials are configured.
 */
export async function uploadDocumentForSigning(params: {
  /** PDF file as Buffer */
  pdfBuffer: Buffer;
  /** Document title/name */
  documentName: string;
  /** Signer's name */
  signerName: string;
  /** Signer's email */
  signerEmail: string;
  /** Signer's phone (for Aadhaar OTP) */
  signerPhone: string;
  /** Signing method: aadhaar_otp or dsc */
  signMethod?: "aadhaar_otp" | "dsc";
  /** Expiry in days */
  expiryDays?: number;
}): Promise<DigioUploadResponse> {
  if (!process.env.DIGIO_CLIENT_ID || !process.env.DIGIO_CLIENT_SECRET) {
    console.warn("[Digio Stub] No credentials configured. Returning mock response.");
    return createMockUploadResponse(params.documentName);
  }

  // TODO: Implement real Digio API call
  // const baseUrl = process.env.DIGIO_API_BASE_URL || "https://api.digio.in";
  // const auth = Buffer.from(`${process.env.DIGIO_CLIENT_ID}:${process.env.DIGIO_CLIENT_SECRET}`).toString("base64");
  //
  // const response = await fetch(`${baseUrl}/v2/client/document/upload`, {
  //   method: "POST",
  //   headers: {
  //     Authorization: `Basic ${auth}`,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     signers: [{
  //       identifier: params.signerEmail,
  //       name: params.signerName,
  //       sign_type: params.signMethod === "dsc" ? "electronic" : "aadhaar",
  //     }],
  //     file_name: params.documentName,
  //     file_data: params.pdfBuffer.toString("base64"),
  //     expire_in_days: params.expiryDays || 15,
  //     notify_signers: true,
  //   }),
  // });
  //
  // const data = await response.json();
  // return { documentId: data.id, signUrl: data.signing_url, status: data.status, expiresAt: data.expire_at };

  return createMockUploadResponse(params.documentName);
}

/**
 * Get the current signing status of a Digio document.
 *
 * STUB: Returns mock data until Digio credentials are configured.
 */
export async function getSigningStatus(
  documentId: string
): Promise<DigioSigningStatus> {
  if (!process.env.DIGIO_CLIENT_ID || !process.env.DIGIO_CLIENT_SECRET) {
    console.warn("[Digio Stub] No credentials configured. Returning mock status.");
    return createMockSigningStatus(documentId);
  }

  // TODO: Implement real Digio API call
  // const baseUrl = process.env.DIGIO_API_BASE_URL || "https://api.digio.in";
  // const auth = Buffer.from(`${process.env.DIGIO_CLIENT_ID}:${process.env.DIGIO_CLIENT_SECRET}`).toString("base64");
  //
  // const response = await fetch(`${baseUrl}/v2/client/document/${documentId}`, {
  //   headers: { Authorization: `Basic ${auth}` },
  // });
  //
  // const data = await response.json();
  // return { ... };

  return createMockSigningStatus(documentId);
}

/**
 * Download the signed document from Digio.
 *
 * STUB: Returns mock data until Digio credentials are configured.
 */
export async function downloadSignedDocument(
  documentId: string
): Promise<DigioDownloadResult> {
  if (!process.env.DIGIO_CLIENT_ID || !process.env.DIGIO_CLIENT_SECRET) {
    console.warn("[Digio Stub] No credentials configured. Returning mock download.");
    return {
      pdfBase64: "",
      fileName: `signed-${documentId}.pdf`,
    };
  }

  // TODO: Implement real Digio API call
  // const baseUrl = process.env.DIGIO_API_BASE_URL || "https://api.digio.in";
  // const auth = Buffer.from(`${process.env.DIGIO_CLIENT_ID}:${process.env.DIGIO_CLIENT_SECRET}`).toString("base64");
  //
  // const response = await fetch(`${baseUrl}/v2/client/document/${documentId}/download`, {
  //   headers: { Authorization: `Basic ${auth}` },
  // });
  //
  // const buffer = await response.arrayBuffer();
  // return { pdfBase64: Buffer.from(buffer).toString("base64"), fileName: `signed-${documentId}.pdf` };

  return {
    pdfBase64: "",
    fileName: `signed-${documentId}.pdf`,
  };
}

// ================================================================
// Mock Helpers (for sandbox/development)
// ================================================================

function createMockUploadResponse(documentName: string): DigioUploadResponse {
  const mockId = `DIG${Date.now().toString(36).toUpperCase()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 15);

  return {
    documentId: mockId,
    signUrl: IS_SANDBOX
      ? `https://app.digio.in/#/gateway/login/${mockId}`
      : `https://app.digio.in/#/gateway/login/${mockId}`,
    status: "CREATED",
    expiresAt: expiresAt.toISOString(),
  };
}

function createMockSigningStatus(documentId: string): DigioSigningStatus {
  return {
    documentId,
    status: "REQUESTED",
    signers: [
      {
        name: "Mock Signer",
        email: "signer@example.com",
        status: "PENDING",
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}
