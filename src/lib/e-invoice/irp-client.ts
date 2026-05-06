/**
 * Vendor-agnostic IRP client interface.
 *
 * The same surface works whether we call NIC directly (with full crypto)
 * or go through a private IRP / GSP (REST + JWT). The concrete adapter
 * is selected at runtime based on `app_settings.einvoice_irp_provider`.
 *
 * Adapters live in:
 *   src/lib/e-invoice/adapters/
 *     ├── iris.ts          (IRIS IRP6 — REST, our default)
 *     ├── nic-direct.ts    (Direct NIC — RSA + AES-SEK)
 *     └── ... (other GSPs)
 *
 * NONE of these adapters exist yet — created in a follow-up phase once
 * IRIS sandbox credentials are received.
 */

import type {
  NicEInvoicePayload,
  NicGenerateIrnSuccess,
  NicCancelIrnRequest,
  NicCancelIrnSuccess,
  NicErrorDetail,
} from "./types";

export type IrpEnvironment = "sandbox" | "production";
export type IrpProvider = "einvoice6" | "nic1" | "nic2" | "iris" | "cygnet" | "cleartax";

export interface IrpCredentials {
  username: string;
  password: string;        // plaintext at use-site only — encrypted at rest
  client_id: string;
  client_secret: string;
}

export interface IrpClientConfig {
  provider: IrpProvider;
  environment: IrpEnvironment;
  gstin: string;
  credentials: IrpCredentials;
}

/** Discriminated result type — caller never has to inspect both branches blindly */
export type IrpResult<T> =
  | { ok: true; data: T; latency_ms: number }
  | { ok: false; error: { code: string; message: string; details?: NicErrorDetail[] }; latency_ms: number };

/** The interface every adapter must satisfy. */
export interface IrpClient {
  /** Lightweight ping — verifies credentials work and a token can be obtained. */
  authTest(): Promise<IrpResult<{ token_expires_at: string }>>;

  /** Submit an e-invoice for IRN registration. */
  generateIrn(payload: NicEInvoicePayload): Promise<IrpResult<NicGenerateIrnSuccess>>;

  /** Cancel an existing IRN within the 24-hour window. */
  cancelIrn(req: NicCancelIrnRequest): Promise<IrpResult<NicCancelIrnSuccess>>;

  /** Retrieve a previously-generated IRN by its hash. */
  getIrn(irn: string): Promise<IrpResult<NicGenerateIrnSuccess>>;

  /**
   * Retrieve an IRN by document details (used when we hit a duplicate-IRN
   * error and need to recover the existing IRN data).
   */
  getIrnByDocument(
    docType: "INV" | "CRN" | "DBN",
    docNumber: string,
    docDateDdMmYyyy: string
  ): Promise<IrpResult<NicGenerateIrnSuccess>>;
}

/**
 * Factory — selects the right adapter based on config.
 *
 * Throws if the configured provider has no adapter yet. We use this at
 * the API-route level to fail fast with a clear message during rollout.
 */
export function createIrpClient(_config: IrpClientConfig): IrpClient {
  // Adapter implementations are added as separate files; keep this stub
  // returning a clear error until at least one is wired up. Once IRIS
  // adapter ships, we'll import + branch here:
  //
  //   if (config.provider === "einvoice6") return new IrisIrpClient(config);
  //   if (config.provider === "nic1")      return new NicDirectClient(config);
  //
  throw new Error(
    "IRP adapter not implemented yet. " +
    "This is created in Phase 2 (final) once IRIS sandbox credentials are received. " +
    "All upstream code (validator, schema-mapper, types) is ready and tested."
  );
}
