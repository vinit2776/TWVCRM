/**
 * NIC-protocol IRP adapter — works for both:
 *   - IRIS IRP6 (api.sandbox.core.irisirp.com / api.einvoice6.gst.gov.in)
 *   - Direct NIC (einv-apisandbox.nic.in / api.einvoice1.gst.gov.in)
 *
 * Because IRIS replicates NIC's API protocol byte-for-byte (URL paths,
 * encryption, response shapes), one adapter handles both. The hostname
 * + public key are configured per provider.
 *
 * Encryption ceremony (per request):
 *   1. Get a valid AuthToken + SEK (cached or freshly-acquired)
 *   2. AES-256-ECB-PKCS7 encrypt the JSON payload using the SEK → Base64
 *   3. POST { "Data": "<base64>" } with auth headers
 *   4. Decrypt response.Data (also Base64+SEK-encrypted) → JSON
 *
 * Auth ceremony (when token expires):
 *   1. Generate a 32-byte AppKey (random)
 *   2. RSA-encrypt password and AppKey with the IRP's public key (PKCS1)
 *   3. POST /eivital/v1.04/auth with the four credentials + ForceRefresh flag
 *   4. Response Data field decrypts (using AppKey, AES-ECB) into:
 *      { AuthToken, Sek (base64-AES-encrypted with our AppKey), TokenExpiry }
 *   5. Decrypt SEK with AppKey
 *   6. Persist { AuthToken, SEK, TokenExpiry } to cache
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateAppKey,
  rsaEncryptToBase64,
  encryptIrpRequestBody,
  decryptIrpResponseData,
  decryptSek,
} from "../crypto";
import { loadSession, saveSession, clearSession } from "../token-cache";
import { lookupNicError } from "../errors";
import { lookupPublicKey } from "../public-keys";
import type {
  IrpClient,
  IrpClientConfig,
  IrpResult,
} from "../irp-client";
import type {
  NicEInvoicePayload,
  NicGenerateIrnSuccess,
  NicCancelIrnRequest,
  NicCancelIrnSuccess,
  NicErrorDetail,
} from "../types";

// ─── Per-provider host configuration ─────────────────────────────────────────
// Public keys are embedded in src/lib/e-invoice/public-keys.ts (they aren't
// secrets) and resolved via lookupPublicKey().

const HOST_BASE_URLS: Record<string, Record<string, string>> = {
  einvoice6: {
    sandbox: "https://api.sandbox.core.irisirp.com",
    production: "https://api.einvoice6.gst.gov.in",
  },
  nic1: {
    sandbox: "https://einv-apisandbox.nic.in",
    production: "https://api.einvoice1.gst.gov.in",
  },
  nic2: {
    production: "https://api.einvoice2.gst.gov.in",
  },
};

// ─── Wire types ─────────────────────────────────────────────────────────────

interface IrpEnvelope {
  Status: 0 | 1 | "0" | "1";
  Data?: string;             // Base64 + SEK-encrypted on success
  ErrorDetails?: string;     // Base64 + SEK-encrypted on failure (sometimes plain JSON array)
  InfoDtls?: string | null;
}

interface AuthSuccessInner {
  AuthToken: string;
  Sek: string;               // Base64 + AppKey-AES-encrypted
  TokenExpiry: string;       // "yyyy-MM-dd HH:mm:ss"
  ClientId?: string;
  UserName?: string;
}

// ─── Adapter implementation ─────────────────────────────────────────────────

export class NicProtocolIrpClient implements IrpClient {
  private readonly baseUrl: string;
  private readonly publicKeyPem: string;

  constructor(
    private readonly config: IrpClientConfig,
    private readonly supabase: SupabaseClient,
  ) {
    const providerHosts = HOST_BASE_URLS[config.provider];
    if (!providerHosts) {
      throw new Error(`No host config for provider "${config.provider}"`);
    }
    const baseUrl = providerHosts[config.environment];
    if (!baseUrl) {
      throw new Error(
        `Provider "${config.provider}" has no ${config.environment} environment configured`
      );
    }
    const publicKey = lookupPublicKey(config.provider, config.environment);
    if (!publicKey) {
      throw new Error(
        `Public key not configured for ${config.provider}/${config.environment}. ` +
        `Add the PEM to src/lib/e-invoice/public-keys.ts (request from IRP if needed).`
      );
    }
    this.baseUrl = baseUrl;
    this.publicKeyPem = publicKey;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /** Get a valid session, reusing cache or refreshing as needed. */
  private async getSession(forceRefresh = false): Promise<{ authToken: string; sek: Buffer; expiresAt: Date }> {
    if (!forceRefresh) {
      const cached = await loadSession(this.supabase);
      if (cached) return cached;
    }
    return this.authenticate();
  }

  /** Perform a fresh auth round-trip. */
  private async authenticate(): Promise<{ authToken: string; sek: Buffer; expiresAt: Date }> {
    const appKey = generateAppKey();
    const appKeyBase64 = appKey.toString("base64");

    const payload = {
      UserName: this.config.credentials.username,
      Password: rsaEncryptToBase64(this.publicKeyPem, this.config.credentials.password),
      AppKey: rsaEncryptToBase64(this.publicKeyPem, appKeyBase64),
      ForceRefreshAccessToken: false,
    };

    const start = Date.now();
    const res = await fetch(`${this.baseUrl}/eivital/v1.04/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "client_id": this.config.credentials.client_id,
        "client_secret": this.config.credentials.client_secret,
        "Gstin": this.config.gstin,
      },
      body: JSON.stringify(payload),
    });
    const latency = Date.now() - start;

    const body: IrpEnvelope = await res.json();
    if (String(body.Status) !== "1" || !body.Data) {
      const err = parseErrorEnvelope(body);
      throw new IrpAuthError(err.code, err.message, latency);
    }

    // Auth response Data is encrypted with our AppKey (NOT SEK — there's no SEK yet!)
    const authJson: AuthSuccessInner = decryptIrpResponseData(appKey, body.Data);

    // Now decrypt the SEK from inside that response — also encrypted with our AppKey
    const sek = decryptSek(appKey, authJson.Sek);

    // TokenExpiry is "yyyy-MM-dd HH:mm:ss" in IST — parse as IST
    const expiresAt = parseIrpTimestamp(authJson.TokenExpiry);

    await saveSession(this.supabase, {
      authToken: authJson.AuthToken,
      sek,
      expiresAt,
    });

    return { authToken: authJson.AuthToken, sek, expiresAt };
  }

  // ─── Public API methods ───────────────────────────────────────────────────

  async authTest(): Promise<IrpResult<{ token_expires_at: string }>> {
    const start = Date.now();
    try {
      const session = await this.getSession(true); // force fresh
      return {
        ok: true,
        data: { token_expires_at: session.expiresAt.toISOString() },
        latency_ms: Date.now() - start,
      };
    } catch (e) {
      return errorResult(e, Date.now() - start);
    }
  }

  async generateIrn(payload: NicEInvoicePayload): Promise<IrpResult<NicGenerateIrnSuccess>> {
    return this.encryptedPost<NicGenerateIrnSuccess>(
      "/eicore/v1.03/Invoice",
      payload as unknown as Record<string, unknown>
    );
  }

  async cancelIrn(req: NicCancelIrnRequest): Promise<IrpResult<NicCancelIrnSuccess>> {
    return this.encryptedPost<NicCancelIrnSuccess>(
      "/eicore/v1.03/Invoice/Cancel",
      req as unknown as Record<string, unknown>
    );
  }

  async getIrn(irn: string): Promise<IrpResult<NicGenerateIrnSuccess>> {
    return this.authedGet<NicGenerateIrnSuccess>(`/eicore/v1.03/Invoice/irn/${irn}`);
  }

  async getIrnByDocument(
    docType: "INV" | "CRN" | "DBN",
    docNumber: string,
    docDateDdMmYyyy: string
  ): Promise<IrpResult<NicGenerateIrnSuccess>> {
    const qs = new URLSearchParams({ doctype: docType, docnum: docNumber, docdate: docDateDdMmYyyy });
    return this.authedGet<NicGenerateIrnSuccess>(`/eicore/v1.03/Invoice/irnbydocdetails?${qs}`);
  }

  // ─── Internal: encrypted POST with auto-retry on auth expiry ─────────────

  private async encryptedPost<T>(
    path: string,
    plainPayload: Record<string, unknown>,
    isRetry = false
  ): Promise<IrpResult<T>> {
    const start = Date.now();
    const session = await this.getSession();

    const dataB64 = encryptIrpRequestBody(session.sek, plainPayload);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "client_id": this.config.credentials.client_id,
        "client_secret": this.config.credentials.client_secret,
        "Gstin": this.config.gstin,
        "user_name": this.config.credentials.username,
        "AuthToken": session.authToken,
      },
      body: JSON.stringify({ Data: dataB64 }),
    });

    const latency = Date.now() - start;
    let body: IrpEnvelope;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        error: { code: "PARSE_ERROR", message: `Non-JSON response (HTTP ${res.status})` },
        latency_ms: latency,
      };
    }

    if (String(body.Status) === "1" && body.Data) {
      const decrypted = decryptIrpResponseData<T>(session.sek, body.Data);
      return { ok: true, data: decrypted, latency_ms: latency };
    }

    // Failure path
    const err = parseErrorEnvelope(body);

    // If the IRP says token expired and we haven't retried yet, refresh + retry once.
    if (!isRetry && (err.code === "1001" || err.code === "1002")) {
      await clearSession(this.supabase);
      return this.encryptedPost<T>(path, plainPayload, true);
    }

    return {
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
      latency_ms: latency,
    };
  }

  /** GET endpoints (Get IRN by IRN / by doc) — no body to encrypt, but auth headers required. */
  private async authedGet<T>(path: string, isRetry = false): Promise<IrpResult<T>> {
    const start = Date.now();
    const session = await this.getSession();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "client_id": this.config.credentials.client_id,
        "client_secret": this.config.credentials.client_secret,
        "Gstin": this.config.gstin,
        "user_name": this.config.credentials.username,
        "AuthToken": session.authToken,
      },
    });
    const latency = Date.now() - start;

    let body: IrpEnvelope;
    try { body = await res.json(); } catch {
      return { ok: false, error: { code: "PARSE_ERROR", message: `HTTP ${res.status}` }, latency_ms: latency };
    }

    if (String(body.Status) === "1" && body.Data) {
      const decrypted = decryptIrpResponseData<T>(session.sek, body.Data);
      return { ok: true, data: decrypted, latency_ms: latency };
    }

    const err = parseErrorEnvelope(body);
    if (!isRetry && (err.code === "1001" || err.code === "1002")) {
      await clearSession(this.supabase);
      return this.authedGet<T>(path, true);
    }
    return { ok: false, error: { code: err.code, message: err.message, details: err.details }, latency_ms: latency };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

class IrpAuthError extends Error {
  constructor(public code: string, message: string, public latency_ms: number) {
    super(message);
  }
}

function parseErrorEnvelope(body: IrpEnvelope): { code: string; message: string; details?: NicErrorDetail[] } {
  const errString = body.ErrorDetails;
  if (!errString) return { code: "UNKNOWN", message: "IRP returned failure with no ErrorDetails" };

  // ErrorDetails is typically a JSON array; sometimes Base64-wrapped
  let parsed: unknown;
  try {
    parsed = JSON.parse(errString);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(errString, "base64").toString("utf8"));
    } catch {
      return { code: "UNKNOWN", message: errString };
    }
  }

  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0] as NicErrorDetail;
    const meta = lookupNicError(first.ErrorCode, first.ErrorMessage);
    return {
      code: first.ErrorCode,
      message: meta.detail,
      details: parsed as NicErrorDetail[],
    };
  }

  return { code: "UNKNOWN", message: JSON.stringify(parsed) };
}

function errorResult<T>(e: unknown, latency_ms: number): IrpResult<T> {
  if (e instanceof IrpAuthError) {
    return { ok: false, error: { code: e.code, message: e.message }, latency_ms };
  }
  if (e instanceof Error) {
    return { ok: false, error: { code: "EXCEPTION", message: e.message }, latency_ms };
  }
  return { ok: false, error: { code: "UNKNOWN", message: String(e) }, latency_ms };
}

/**
 * Parse "yyyy-MM-dd HH:mm:ss" returned by the IRP into a JS Date.
 * The IRP's clock is IST (UTC+5:30); we apply that offset.
 */
function parseIrpTimestamp(ts: string): Date {
  // Format: "2026-05-15 14:30:00"
  const [datePart, timePart] = ts.split(" ");
  if (!datePart || !timePart) return new Date(ts);
  // Treat as IST and convert to UTC
  const istIso = `${datePart}T${timePart}+05:30`;
  return new Date(istIso);
}
