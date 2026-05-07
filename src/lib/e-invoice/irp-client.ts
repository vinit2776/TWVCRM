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
  | { ok: true; data: T; latency_ms: number; raw_response?: unknown }
  | { ok: false; error: { code: string; message: string; details?: NicErrorDetail[] }; latency_ms: number; raw_response?: unknown; http_status?: number };

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

  /**
   * GET /eivital/v1.04/Master/gstin/{gstin}
   * Retrieve a GSTIN's details from the IRP's master (GSTN-sourced).
   * Used for buyer-GSTIN auto-fill and seller details sync.
   */
  getGstinDetails(gstin: string): Promise<IrpResult<GstinMasterDetails>>;
}

export interface GstinMasterDetails {
  Gstin?: string;
  LglNm?: string;          // Legal name
  TrdNm?: string;          // Trade name
  Status?: string;         // ACT / CNL / SUSP / INA
  BlkStatus?: string;      // Block status
  DtReg?: string;          // Registration date
  DtDReg?: string;         // De-registration date
  AddrBnm?: string;        // Building name
  AddrBno?: string;        // Building number
  AddrFlno?: string;       // Floor number
  AddrSt?: string;         // Street
  AddrLoc?: string;        // Location
  AddrCity?: string;       // City (older field)
  Loc?: string;            // Location (newer field)
  Adr1?: string;           // Address line 1 (composed)
  Adr2?: string;           // Address line 2
  Pncd?: number;           // Pincode
  Stcd?: string;           // State code
  TxpTyp?: string;         // Taxpayer type
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { NicProtocolIrpClient } from "./adapters/nic-protocol";

/**
 * Factory — selects the right adapter based on config.
 *
 * IRIS, NIC1, and NIC2 all use the same wire protocol (RSA + AES-SEK),
 * so a single adapter handles all three; only host + public key differ.
 */
export function createIrpClient(
  config: IrpClientConfig,
  supabase: SupabaseClient,
): IrpClient {
  switch (config.provider) {
    case "einvoice6":   // IRIS IRP6
    case "nic1":
    case "nic2":
      return new NicProtocolIrpClient(config, supabase);
    case "iris":        // alias for einvoice6
      return new NicProtocolIrpClient({ ...config, provider: "einvoice6" }, supabase);
    case "cygnet":
    case "cleartax":
      throw new Error(
        `Provider "${config.provider}" adapter not yet implemented. ` +
        `Add an adapter in src/lib/e-invoice/adapters/ that implements IrpClient.`
      );
    default:
      throw new Error(`Unknown IRP provider "${config.provider}"`);
  }
}
