/**
 * CRM API client — all HTTPS calls to twv-crm.vercel.app.
 * Every request is authenticated with the TALLY_AGENT_TOKEN.
 */

import { Config } from "./config";
import { log } from "./logger";

export interface PendingJob {
  id:                    string;
  job_type:              "sales_voucher" | "party_master" | "receipt_voucher" | "credit_note";
  idempotency_key:       string;
  payload:               Record<string, unknown>;
  billing_statement_id:  string | null;
  gst_invoice_id:        string | null;
  attempt_count:         number;
  max_attempts:          number;
}

export interface PendingResponse {
  jobs:                 PendingJob[];
  tally_company_gstin:  string;
  lease_seconds:        number;
  reason?:              string;
  message?:             string;
  locked_company?:      string;
  detected_company?:    string;
}

export interface AckSuccess {
  success:              true;
  job_id:               string;
  /** Which kind of voucher this ack is for. Defaults to 'sales' server-side.
   *  'receipt' marks the job done + mirrors the receipt onto the payment;
   *  'credit_note' voids the statement (cancel confirmed) — neither delivers. */
  voucher_kind?:        "sales" | "receipt" | "credit_note";
  tally_voucher_guid:   string;
  tally_invoice_number: string;   // for receipts, carries the Receipt voucher number
  tally_irn?:           string;
  tally_ack_no?:        string;
  tally_ack_date?:      string;
  tally_signed_qr_code?:string;
  tally_total_amount:   number;
  irn_pending:          boolean;
  voucher_created_at?:  string;
}

export interface AckFailure {
  success:   false;
  job_id:    string;
  error:     string;
  retryable: boolean;
}

export type AckPayload = AckSuccess | AckFailure;

export interface HeartbeatPayload {
  bridge_instance_id:   string;
  version:              string;
  tally_connected:      boolean;
  tally_company_name:   string | null;
  tally_company_gstin:  string | null;
  crm_connected:        boolean;
  pending_count:        number;
  failed_count:         number;
  last_sync_at:         string | null;
  last_error:           string | null;
}

export class CrmClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly instanceId: string;

  constructor(config: Config) {
    this.baseUrl    = config.crm_base_url.replace(/\/$/, "");
    this.token      = config.agent_token;
    this.instanceId = config.instance_id;
  }

  private headers(): Record<string, string> {
    return {
      "Authorization":      `Bearer ${this.token}`,
      "Content-Type":       "application/json",
      "x-bridge-instance-id": this.instanceId,
    };
  }

  private async fetch<T>(path: string, options?: RequestInit, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { ...options, headers: { ...this.headers(), ...extraHeaders } });
    if (res.status === 401) throw new Error("CRM rejected agent token (401). Check TALLY_AGENT_TOKEN in Vercel env.");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CRM ${options?.method ?? "GET"} ${path} → ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Poll for pending jobs. Sends the currently-open Tally company so the CRM
   *  can enforce the wrong-company guard server-side. */
  async getPending(detectedCompany: string | null): Promise<PendingResponse> {
    return this.fetch<PendingResponse>(
      "/api/tally/pending",
      undefined,
      detectedCompany ? { "x-tally-company": detectedCompany } : undefined
    );
  }

  /** Get B2B invoices created in Tally that are still awaiting their IRN. */
  async getAwaitingIrn(): Promise<Array<{
    job_id: string; invoice_number: string; voucher_guid: string | null; voucher_created_at: string | null;
  }>> {
    const res = await this.fetch<{ vouchers: Array<{
      job_id: string; invoice_number: string; voucher_guid: string | null; voucher_created_at: string | null;
    }> }>("/api/tally/awaiting-irn");
    return res.vouchers ?? [];
  }

  /** Ack a job (success or failure). */
  async ack(payload: AckPayload): Promise<void> {
    await this.fetch<unknown>("/api/tally/ack", {
      method: "POST",
      body:   JSON.stringify(payload),
    });
  }

  /** Send heartbeat. Returns whether the GSTIN on Tally matches expected. */
  async heartbeat(payload: HeartbeatPayload): Promise<{ gstin_mismatch: boolean; warning?: string }> {
    try {
      return await this.fetch<{ gstin_mismatch: boolean; warning?: string }>(
        "/api/tally/heartbeat",
        { method: "POST", body: JSON.stringify(payload) }
      );
    } catch (err) {
      log.warn(`Heartbeat failed: ${String(err)}`);
      return { gstin_mismatch: false };
    }
  }

  /**
   * Posts a snapshot batch to the read-only sync-pull endpoint. Bridge 1.4.0+
   * — additive, never mutates Tally. The CRM uses these snapshots for the
   *   handoff_v2 inbox's Tally bridge verification badges and receipt
   *   auto-complete (handoff_state → 'complete' when a matched receipt is
   *   seen in Tally).
   */
  async postSyncPull(payload: {
    sync_batch_id: string;
    company_name: string;
    vouchers: Array<{
      voucher_master_id: string;
      voucher_kind: "sales" | "receipt" | "credit_note";
      voucher_series: string | null;
      invoice_number: string | null;
      party_name: string | null;
      party_gstin: string | null;
      voucher_date: string | null;
      voucher_amount: number | null;
      irn: string | null;
      against_voucher: string | null;
      custom_fields: Record<string, string>;
    }>;
    parties: Array<{ ledger_name: string; gstin: string | null; address: string | null }>;
  }, detectedCompany: string): Promise<{ accepted: number; matched: number; unmatched: number; auto_completed: number }> {
    return this.fetch<{ accepted: number; matched: number; unmatched: number; auto_completed: number }>(
      "/api/tally/sync-pull",
      { method: "POST", body: JSON.stringify(payload) },
      { "x-tally-company": detectedCompany },
    );
  }
}
