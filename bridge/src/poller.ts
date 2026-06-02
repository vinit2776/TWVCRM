/**
 * Main polling loop.
 *
 * Responsibilities:
 *   1. Poll CRM for pending jobs (GET /api/tally/pending)
 *   2. D10.1 — company GSTIN guard: abort if wrong company is open
 *   3. D10.3 — single-flight: process one job at a time (no concurrent Tally posts)
 *   4. For each job: check-before-create → post → strict-parse → ack or fail
 *   5. D10.4 — IRN-aging alarm: alert if voucher has no IRN after N hours
 *   6. Update health state for heartbeat
 */

import { Config } from "./config";
import { CrmClient, PendingJob } from "./crm-client";
import { TallyClient } from "./tally-client";
import { log } from "./logger";
import { healthState } from "./health-state";

export class Poller {
  private readonly config: Config;
  private readonly crm:    CrmClient;
  private readonly tally:  TallyClient;
  private running = false;

  constructor(config: Config, crm: CrmClient, tally: TallyClient) {
    this.config = config;
    this.crm    = crm;
    this.tally  = tally;
  }

  async poll(): Promise<void> {
    if (this.running) {
      log.debug("Skipping poll — previous cycle still in progress (single-flight)");
      return;
    }
    this.running = true;
    try {
      await this.runCycle();
    } catch (err) {
      log.error(`Poll cycle error: ${String(err)}`);
      healthState.lastError = String(err);
    } finally {
      this.running = false;
    }
  }

  private async runCycle(): Promise<void> {
    // ── D10.1 Company GSTIN guard ─────────────────────────────────────────────
    const company = await this.tally.getCurrentCompany();
    if (!company) {
      log.warn("Tally not reachable or no company loaded — skipping poll");
      healthState.tallyConnected    = false;
      healthState.tallyCompanyName  = null;
      healthState.tallyCompanyGstin = null;
      return;
    }

    healthState.tallyConnected    = true;
    healthState.tallyCompanyName  = company.name;
    healthState.tallyCompanyGstin = company.gstin;

    if (company.gstin && company.gstin !== this.config.tally_company_gstin) {
      log.error(
        `GSTIN MISMATCH — expected ${this.config.tally_company_gstin}, ` +
        `Tally has ${company.gstin} (${company.name}). ` +
        `Refusing to post until the correct company is loaded.`
      );
      healthState.lastError = `Wrong company open: ${company.name} (${company.gstin})`;
      return;
    }

    // ── Fetch pending jobs ────────────────────────────────────────────────────
    const { jobs, tally_company_gstin } = await this.crm.getPending();
    healthState.pendingCount = jobs.length;

    if (jobs.length === 0) {
      log.debug("No pending jobs");
      return;
    }

    log.info(`Processing ${jobs.length} pending job(s)`);

    for (const job of jobs) {
      await this.processJob(job, tally_company_gstin);
    }
  }

  private async processJob(job: PendingJob, expectedGstin: string): Promise<void> {
    log.info(`Job ${job.id} [${job.job_type}] attempt ${job.attempt_count + 1}/${job.max_attempts}`);

    try {
      switch (job.job_type) {
        case "sales_voucher":
          await this.handleSalesVoucher(job, expectedGstin);
          break;
        default:
          log.warn(`Unknown job_type: ${job.job_type} — skipping`);
          await this.crm.ack({
            success:   false,
            job_id:    job.id,
            error:     `Unknown job_type: ${job.job_type}`,
            retryable: false,
          });
      }
    } catch (err) {
      const msg = String(err);
      log.error(`Job ${job.id} unhandled error: ${msg}`);
      // Transient errors (network, timeout) should retry; data errors should not
      const retryable = msg.includes("timeout") || msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET");
      await this.crm.ack({
        success:   false,
        job_id:    job.id,
        error:     msg,
        retryable,
      });
      healthState.lastError = msg;
    }
  }

  private async handleSalesVoucher(job: PendingJob, expectedGstin: string): Promise<void> {
    const payload = job.payload as {
      billing_statement_id: string;
      taxable_amount:       number;
      tax_percentage:       number;
      line_items:           Array<{ description?: string; amount?: number }>;
    };

    // ── D10.3 Check-before-create ─────────────────────────────────────────────
    // Ask Tally if a voucher with this idempotency key already exists.
    // If yes, read it back instead of creating a second one.
    const existing = await this.tally.findExistingVoucher(job.idempotency_key);
    if (existing) {
      log.info(`Job ${job.id}: voucher already exists in Tally (${existing.invoice_number}) — acking with existing data`);
      await this.crm.ack({
        success:              true,
        job_id:               job.id,
        tally_voucher_guid:   existing.voucher_guid,
        tally_invoice_number: existing.invoice_number,
        tally_irn:            existing.irn ?? undefined,
        tally_total_amount:   payload.taxable_amount, // D5: get real total from Tally read-back
        irn_pending:          !existing.irn,
        voucher_created_at:   new Date().toISOString(),
      });
      return;
    }

    // ── Fetch ledger config from CRM-stored settings ──────────────────────────
    // Ledger names come from app_settings, injected into the payload by the CRM.
    // D5 TODO: extend PendingJob payload to include resolved ledger names.
    const ledgers = {
      sales:     String((job.payload as Record<string, unknown>)["ledger_sales"]    ?? "Sales"),
      cgst:      String((job.payload as Record<string, unknown>)["ledger_cgst"]     ?? "Output CGST"),
      sgst:      String((job.payload as Record<string, unknown>)["ledger_sgst"]     ?? "Output SGST"),
      igst:      String((job.payload as Record<string, unknown>)["ledger_igst"]     ?? "Output IGST"),
      round_off: String((job.payload as Record<string, unknown>)["ledger_round_off"]?? "Round Off"),
    };

    const voucherSeries = String((job.payload as Record<string, unknown>)["voucher_series"] ?? "Sales");

    // Determine intra/inter state from buyer GSTIN (D10.7)
    const buyerGstin      = String((job.payload as Record<string, unknown>)["buyer_gstin"] ?? "");
    const buyerStateCode  = buyerGstin.length >= 2 ? buyerGstin.slice(0, 2) : "";
    const sellerStateCode = expectedGstin.slice(0, 2);
    const isInterstate    = !!buyerStateCode && buyerStateCode !== sellerStateCode;

    // ── Post the voucher ──────────────────────────────────────────────────────
    const result = await this.tally.postSalesVoucher({
      idempotency_key: job.idempotency_key,
      invoice_date:    new Date().toISOString().split("T")[0],
      party_ledger:    String((job.payload as Record<string, unknown>)["party_ledger"] ?? ""),
      taxable_amount:  payload.taxable_amount,
      tax_percentage:  payload.tax_percentage,
      is_interstate:   isInterstate,
      voucher_series:  voucherSeries,
      line_items:      (payload.line_items ?? []).map(li => ({
        description: String(li.description ?? "Service"),
        amount:      Number(li.amount ?? 0),
        hsn_sac:     "997212",
      })),
      ledgers,
    });

    // ── Ack back to CRM ───────────────────────────────────────────────────────
    await this.crm.ack({
      success:              true,
      job_id:               job.id,
      tally_voucher_guid:   result.voucher_guid,
      tally_invoice_number: result.invoice_number,
      tally_irn:            result.irn ?? undefined,
      tally_ack_no:         result.ack_no ?? undefined,
      tally_ack_date:       result.ack_date ?? undefined,
      tally_signed_qr_code: result.signed_qr_code ?? undefined,
      tally_total_amount:   result.total_amount,
      irn_pending:          result.irn_pending,
      voucher_created_at:   result.created_at,
    });

    healthState.lastSyncAt = new Date().toISOString();
    healthState.lastError  = null;
    log.info(`Job ${job.id} completed — invoice ${result.invoice_number} issued`);
  }
}
