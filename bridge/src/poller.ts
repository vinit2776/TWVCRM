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
    // Read the currently-open Tally company (drives the server-side guard).
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

    // ── Company guard (D10.1) — now enforced by the CRM ───────────────────────
    // We send the open company name to /pending. The CRM compares it to the
    // company locked on the Tally Sync Control page and refuses to serve jobs
    // on mismatch. This keeps the lock controllable from the admin UI.
    const { jobs, tally_company_gstin, reason, message } =
      await this.crm.getPending(company.name);
    healthState.pendingCount = jobs.length;

    if (reason === "company_mismatch") {
      log.error(message ?? "Sync blocked: wrong company open in Tally");
      healthState.lastError = message ?? "Wrong company open in Tally";
      return;
    }
    if (reason === "tally_sync_paused") {
      log.debug("Sync paused from the control page — not processing");
      healthState.lastError = null;
      return;
    }
    // Healthy poll — clear any prior mismatch/error
    healthState.lastError = null;

    if (jobs.length > 0) {
      log.info(`Processing ${jobs.length} pending job(s)`);
      for (const job of jobs) {
        await this.processJob(job, tally_company_gstin);
      }
    }

    // IRN read-back: for B2B invoices created earlier and awaiting their IRN,
    // check whether accounts has now generated it; if so, ack it (which
    // completes the invoice and triggers customer delivery).
    await this.checkAwaitingIrn();
  }

  /** Poll Tally for IRNs on invoices that are awaiting them (B2B). */
  private async checkAwaitingIrn(): Promise<void> {
    let awaiting: Awaited<ReturnType<CrmClient["getAwaitingIrn"]>>;
    try {
      awaiting = await this.crm.getAwaitingIrn();
    } catch (err) {
      log.warn(`awaiting-irn fetch failed: ${String(err)}`);
      return;
    }
    if (awaiting.length === 0) return;

    // Date range covering all awaiting vouchers (default to last 60 days).
    const dates = awaiting
      .map((v) => v.voucher_created_at)
      .filter(Boolean)
      .map((d) => (d as string).split("T")[0]);
    const today = new Date().toISOString().split("T")[0];
    const fromDate = dates.length ? dates.sort()[0] : today;
    const toDate   = today;

    log.info(`Checking IRN for ${awaiting.length} awaiting invoice(s) (${fromDate}..${toDate})`);

    let irnMap: Awaited<ReturnType<TallyClient["getIrnMap"]>>;
    try {
      irnMap = await this.tally.getIrnMap(fromDate, toDate);
    } catch (err) {
      log.warn(`getIrnMap failed: ${String(err)}`);
      return;
    }

    for (const v of awaiting) {
      const found = irnMap.get(v.invoice_number);
      if (found?.irn) {
        log.info(`IRN now available for ${v.invoice_number}: ${found.irn} — acking`);
        await this.crm.ack({
          success:              true,
          job_id:               v.job_id,
          tally_voucher_guid:   v.voucher_guid ?? "",
          tally_invoice_number: v.invoice_number,
          tally_irn:            found.irn,
          tally_ack_no:         found.ack_no ?? undefined,
          tally_ack_date:       found.ack_date ?? undefined,
          tally_signed_qr_code: found.signed_qr_code ?? undefined,
          tally_total_amount:   0,            // unchanged; CRM keeps the original total
          irn_pending:          false,        // IRN is now present → complete + send
          voucher_created_at:   v.voucher_created_at ?? undefined,
        });
      }
    }
  }

  private async processJob(job: PendingJob, expectedGstin: string): Promise<void> {
    log.info(`Job ${job.id} [${job.job_type}] attempt ${job.attempt_count + 1}/${job.max_attempts}`);

    try {
      switch (job.job_type) {
        case "sales_voucher":
          await this.handleSalesVoucher(job, expectedGstin);
          break;
        case "receipt_voucher":
          await this.handleReceiptVoucher(job);
          break;
        case "credit_note":
          await this.handleCreditNote(job);
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
    const p = job.payload as Record<string, unknown>;
    const str = (k: string, d = "") => String(p[k] ?? d);
    void expectedGstin;

    // E-invoice (IRN) only applies to B2B customers WITH a GSTIN. B2C never get one.
    const hasGstin = str("buyer_gstin").trim().length >= 15;

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
        irn_pending:          hasGstin && !existing.irn,   // B2C never awaits an IRN
        voucher_created_at:   new Date().toISOString(),
      });
      return;
    }

    // All invoice details (ledgers, party, stock item, place of supply) are
    // injected into the job payload by the CRM /pending endpoint from the
    // Tally Sync Control settings + the customer record (p/str defined above).

    // ── Customer ledger guard ──────────────────────────────────────────────────
    // Default: fail clearly if the customer isn't a ledger in Tally yet, rather
    // than posting a broken voucher. If auto-create is ON (setting), create the
    // Sundry Debtor ledger from the CRM's GST data — but ONLY when no ledger by
    // that exact name exists, so we never duplicate an existing customer.
    const partyLedger = str("party_ledger");
    let partyExists = await this.tally.ledgerExists(partyLedger);
    if (!partyExists && (p["auto_create_ledger"] === true || p["auto_create_ledger"] === "true")) {
      log.info(`Job ${job.id}: ledger "${partyLedger}" missing — auto-create is ON, creating it`);
      try {
        await this.tally.ensurePartyLedger({
          ledger_name: partyLedger,
          gstin:       str("buyer_gstin") || null,
          address:     str("buyer_address"),
          state:       str("buyer_state", "Tamil Nadu"),
          state_code:  "",
        });
        partyExists = await this.tally.ledgerExists(partyLedger);   // confirm it took
      } catch (err) {
        log.error(`Job ${job.id}: auto-create ledger failed: ${String(err)}`);
      }
    }
    if (!partyExists) {
      const msg = `Customer ledger "${partyLedger}" does not exist in Tally. ` +
        `Create it in Tally (Gateway > Create > Ledger, under Sundry Debtors), then Retry. ` +
        `(Or enable auto-create in Admin > Tally Sync.)`;
      log.error(`Job ${job.id}: ${msg}`);
      await this.crm.ack({ success: false, job_id: job.id, error: msg, retryable: false });
      return;
    }

    // ── Post the voucher (SDIPL-REG item-invoice format) ───────────────────────
    const result = await this.tally.postSalesVoucher({
      idempotency_key: job.idempotency_key,
      invoice_date:    new Date().toISOString().split("T")[0],
      voucher_type:    str("voucher_series", "SDIPL-REG"),
      party_ledger:    str("party_ledger"),
      party_gstin:     str("buyer_gstin"),
      party_address:   str("buyer_address"),
      place_of_supply: str("place_of_supply", "Tamil Nadu"),
      stock_item:      str("stock_item", "Rent-The WorkVilla"),
      income_ledger:   str("ledger_sales", "Rent The Workvilla 18%"),
      cgst_ledger:     str("ledger_cgst", "CGST Output 9%"),
      sgst_ledger:     str("ledger_sgst", "SGST Output 9%"),
      tax_percentage:  payload.tax_percentage || 18,
      line_items:      (payload.line_items ?? []).map(li => ({
        description: String(li.description ?? "Service"),
        amount:      Number(li.amount ?? 0),
      })),
    });

    // ── E-invoice applicability (GST rule) ─────────────────────────────────────
    // IRN only applies to B2B (hasGstin, computed above). B2C never await an IRN
    // (else they'd hang forever) — complete the moment the voucher exists.
    const irnPending  = hasGstin && result.irn_pending;   // only B2B awaits an IRN

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
      irn_pending:          irnPending,
      voucher_created_at:   result.created_at,
    });

    healthState.lastSyncAt = new Date().toISOString();
    healthState.lastError  = null;
    log.info(
      `Job ${job.id} completed — invoice ${result.invoice_number} issued ` +
      `(${hasGstin ? (irnPending ? "B2B, awaiting IRN" : "B2B, IRN present") : "B2C, no IRN needed"})`
    );
  }

  /**
   * Reverse-sync: a payment recorded in the CRM → a Receipt voucher in Tally.
   * The CRM /pending endpoint injects party_ledger, receipt_ledger (bank/cash),
   * voucher_series, and narration. We guard both ledgers exist, post the receipt,
   * and ack with voucher_kind='receipt' (the CRM marks the job done + mirrors the
   * receipt number onto the payment; it does NOT trigger invoice delivery).
   */
  private async handleReceiptVoucher(job: PendingJob): Promise<void> {
    const p = job.payload as Record<string, unknown>;
    const str = (k: string, d = "") => String(p[k] ?? d);
    const amount = Number(p["amount"] ?? 0);

    if (!(amount > 0)) {
      await this.crm.ack({ success: false, job_id: job.id, error: `Receipt amount is not positive (${amount})`, retryable: false });
      return;
    }

    // Check-before-create (same stub as sales until a real REMOTEID query is wired —
    // the REMOTEID is embedded so a future findExistingVoucher catches duplicates).
    const existing = await this.tally.findExistingVoucher(job.idempotency_key);
    if (existing) {
      log.info(`Job ${job.id}: receipt already exists in Tally (${existing.invoice_number}) — acking with existing data`);
      await this.crm.ack({
        success:              true,
        job_id:               job.id,
        voucher_kind:         "receipt",
        tally_voucher_guid:   existing.voucher_guid,
        tally_invoice_number: existing.invoice_number,
        tally_total_amount:   amount,
        irn_pending:          false,
        voucher_created_at:   new Date().toISOString(),
      });
      return;
    }

    // ── Ledger guards (require-existing, fail loud) ────────────────────────────
    const partyLedger   = str("party_ledger");
    const receiptLedger = str("receipt_ledger");

    if (!receiptLedger) {
      const msg = `No receipt account configured. Set the bank/cash ledger in Tally Sync settings ` +
        `(tally_ledger_receipt_account) that receives customer payments, then Retry.`;
      log.error(`Job ${job.id}: ${msg}`);
      await this.crm.ack({ success: false, job_id: job.id, error: msg, retryable: false });
      return;
    }
    for (const [label, ledger] of [["Customer", partyLedger], ["Receipt account", receiptLedger]] as const) {
      if (!(await this.tally.ledgerExists(ledger))) {
        const msg = `${label} ledger "${ledger}" does not exist in Tally. Create it, then Retry.`;
        log.error(`Job ${job.id}: ${msg}`);
        await this.crm.ack({ success: false, job_id: job.id, error: msg, retryable: false });
        return;
      }
    }

    const result = await this.tally.postReceiptVoucher({
      idempotency_key: job.idempotency_key,
      receipt_date:    str("payment_date") || new Date().toISOString().split("T")[0],
      voucher_type:    str("voucher_series", "Receipt"),
      party_ledger:    partyLedger,
      receipt_ledger:  receiptLedger,
      invoice_number:  str("tally_invoice_number"),
      amount,
      tds_amount:      Number(p["tds_amount"] ?? 0),
      tds_ledger:      str("tds_ledger") || undefined,
      narration:       str("narration", "TWV CRM Receipt"),
      bill_by_bill:    p["bill_by_bill"] !== false && p["bill_by_bill"] !== "false",   // default ON
      bank_allocation: (p["bank_allocation"] && typeof p["bank_allocation"] === "object")
        ? (p["bank_allocation"] as { transaction_type: string; transfer_mode: string; reference: string })
        : null,
    });

    await this.crm.ack({
      success:              true,
      job_id:               job.id,
      voucher_kind:         "receipt",
      tally_voucher_guid:   result.voucher_guid,
      tally_invoice_number: result.voucher_number,   // receipt voucher number
      tally_total_amount:   result.total_amount,
      irn_pending:          false,
      voucher_created_at:   result.created_at,
    });

    healthState.lastSyncAt = new Date().toISOString();
    healthState.lastError  = null;
    log.info(`Job ${job.id} completed — receipt ${result.voucher_number} for ${result.total_amount.toFixed(2)}`);
  }

  /**
   * CRM-first cancel: post a Credit Note in Tally that reverses a sales invoice.
   * The CRM /pending endpoint injects the ledgers, party, stock item and the
   * original invoice number. On success we ack with voucher_kind='credit_note';
   * the CRM then voids the statement (Tally reversed first → books in sync).
   */
  private async handleCreditNote(job: PendingJob): Promise<void> {
    const p = job.payload as Record<string, unknown>;
    const str = (k: string, d = "") => String(p[k] ?? d);

    const partyLedger = str("party_ledger");
    if (!(await this.tally.ledgerExists(partyLedger))) {
      const msg = `Customer ledger "${partyLedger}" does not exist in Tally. Create it, then Retry.`;
      log.error(`Job ${job.id}: ${msg}`);
      await this.crm.ack({ success: false, job_id: job.id, error: msg, retryable: false });
      return;
    }

    const existing = await this.tally.findExistingVoucher(job.idempotency_key);
    if (existing) {
      log.info(`Job ${job.id}: credit note already exists in Tally (${existing.invoice_number}) — acking with existing data`);
      await this.crm.ack({
        success:              true,
        job_id:               job.id,
        voucher_kind:         "credit_note",
        tally_voucher_guid:   existing.voucher_guid,
        tally_invoice_number: existing.invoice_number,
        tally_total_amount:   Number(p["taxable_amount"] ?? 0),
        irn_pending:          false,
        voucher_created_at:   new Date().toISOString(),
      });
      return;
    }

    const lineItems = (p["line_items"] as Array<{ label?: string; description?: string; subtotal?: number; amount?: number }> | undefined) ?? [];
    const lines = lineItems
      .map((li) => ({ description: String(li.label ?? li.description ?? "Service"), amount: Number(li.subtotal ?? li.amount ?? 0) }))
      .filter((li) => li.amount > 0);
    if (lines.length === 0) {
      lines.push({ description: "Coworking Services", amount: Number(p["taxable_amount"] ?? 0) });
    }

    const result = await this.tally.postCreditNote({
      idempotency_key:  job.idempotency_key,
      credit_date:      new Date().toISOString().split("T")[0],
      voucher_type:     str("voucher_series", "CREDIT NOTE-REG"),
      party_ledger:     partyLedger,
      party_gstin:      str("buyer_gstin"),
      place_of_supply:  str("place_of_supply", "Tamil Nadu"),
      stock_item:       str("stock_item", "Rent-The WorkVilla"),
      income_ledger:    str("ledger_sales", "Rent The Workvilla 18%"),
      cgst_ledger:      str("ledger_cgst", "CGST Output 9%"),
      sgst_ledger:      str("ledger_sgst", "SGST Output 9%"),
      tax_percentage:   Number(p["tax_percentage"] ?? 18),
      original_invoice: str("original_invoice_number"),
      original_invoice_date: str("original_invoice_date") || undefined,
      line_items:       lines,
      narration:        str("narration", "TWV CRM Credit Note"),
    });

    await this.crm.ack({
      success:              true,
      job_id:               job.id,
      voucher_kind:         "credit_note",
      tally_voucher_guid:   result.voucher_guid,
      tally_invoice_number: result.voucher_number,   // credit note number
      tally_irn:            result.irn ?? undefined,
      tally_total_amount:   result.total_amount,
      irn_pending:          result.irn_pending,
      voucher_created_at:   result.created_at,
    });

    healthState.lastSyncAt = new Date().toISOString();
    healthState.lastError  = null;
    log.info(`Job ${job.id} completed — credit note ${result.voucher_number} reverses ${str("original_invoice_number")}`);
  }
}
