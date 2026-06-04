/**
 * GET /api/tally/pending
 *
 * Bridge-only endpoint. Returns a batch of pending Tally sync jobs and
 * claims them with a lease. The bridge must ack (POST /api/tally/ack)
 * before the lease expires or the job re-surfaces for retry.
 *
 * Also re-surfaces any claimed jobs whose lease has expired (bridge crash).
 *
 * Auth: Bearer TALLY_AGENT_TOKEN (not a user session)
 *
 * Response:
 *   { jobs: TallySyncJob[] }
 *
 * Lease semantics:
 *   - claimed_at      = now
 *   - lease_expires_at = now + LEASE_SECONDS
 *   - status          = 'claimed'
 *   If bridge acks before expiry → status = 'completed' | 'failed'
 *   If bridge crashes            → job re-surfaces on next poll after expiry
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

const BATCH_SIZE    = 5;    // jobs per poll — keeps individual Tally posts manageable
const LEASE_SECONDS = 120;  // bridge must ack within 2 minutes or job re-surfaces

function authGuard(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${process.env.TALLY_AGENT_TOKEN}`;
}

export async function GET(request: NextRequest) {
  if (!authGuard(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_SECONDS * 1000);

  // Re-surface any jobs whose lease has expired (crashed bridge)
  await supabase
    .from("tally_sync_jobs")
    .update({ status: "pending", claimed_at: null, lease_expires_at: null, claimed_by: null })
    .eq("status", "claimed")
    .lt("lease_expires_at", now.toISOString());

  // Check master switch + company lock + ledger mapping (for job enrichment)
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "tally_sync_enabled", "tally_company_gstin", "tally_locked_company",
      "tally_ledger_rent_income", "tally_ledger_usage_income",
      "tally_ledger_cgst_output", "tally_ledger_sgst_output", "tally_ledger_igst_output",
      "tally_ledger_round_off", "tally_party_ledger_suffix", "tally_voucher_series",
      "tally_stock_item", "tally_place_of_supply", "tally_hsn_code",
      "tally_ledger_receipt_account", "tally_receipt_voucher_series",
      "tally_receipt_bill_by_bill", "tally_receipt_account_is_bank",
      "tally_receipt_transaction_type", "tally_receipt_transfer_mode",
    ]);

  const settingsMap = Object.fromEntries(
    (settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value])
  );

  if (settingsMap["tally_sync_enabled"] !== "true") {
    return NextResponse.json({ jobs: [], reason: "tally_sync_paused" });
  }

  // ── Company guard (D10.1, enforced server-side) ──────────────────────────────
  // The bridge reports the currently-open Tally company via x-tally-company.
  // If a company is locked and the open company doesn't match, refuse to serve
  // jobs — this prevents posting invoices into the wrong company's books.
  const lockedCompany   = (settingsMap["tally_locked_company"] ?? "").trim();
  const detectedCompany = (request.headers.get("x-tally-company") ?? "").trim();

  if (lockedCompany && detectedCompany && lockedCompany !== detectedCompany) {
    return NextResponse.json({
      jobs: [],
      reason: "company_mismatch",
      locked_company: lockedCompany,
      detected_company: detectedCompany,
      message: `Sync blocked: locked to "${lockedCompany}" but Tally has "${detectedCompany}" open.`,
    });
  }

  // Claim a batch atomically: select then update
  // Note: Postgres has no SELECT FOR UPDATE SKIP LOCKED via PostgREST,
  // so we use a deterministic ordering + lease expiry as the dedup.
  // Single-flight is enforced by the bridge itself (one concurrent poster).
  const { data: jobs, error } = await supabase
    .from("tally_sync_jobs")
    .select(`
      id, job_type, idempotency_key, payload,
      billing_statement_id, gst_invoice_id,
      attempt_count, max_attempts
    `)
    .eq("status", "pending")
    .lt("attempt_count", BATCH_SIZE)     // don't pick up exhausted jobs
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[tally/pending] query error:", error.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  const jobIds = jobs.map((j: { id: string }) => j.id);
  const bridgeInstanceId = request.headers.get("x-bridge-instance-id") ?? "unknown";

  // Claim the batch + increment attempt counts individually
  // (Supabase PostgREST doesn't support col+1 in update, so two passes)
  for (const job of jobs) {
    await supabase
      .from("tally_sync_jobs")
      .update({
        status:            "claimed",
        claimed_at:        now.toISOString(),
        lease_expires_at:  leaseExpiry.toISOString(),
        claimed_by:        bridgeInstanceId,
        attempt_count:     (job.attempt_count ?? 0) + 1,
        last_attempted_at: now.toISOString(),
      })
      .eq("id", job.id);
  }

  // Look up the bridge version from its last heartbeat (best-effort — null if not found)
  let bridgeVersion: string | null = null;
  if (bridgeInstanceId !== "unknown") {
    const { data: health } = await supabase
      .from("tally_bridge_health")
      .select("version")
      .eq("bridge_instance_id", bridgeInstanceId)
      .single();
    bridgeVersion = (health as { version?: string | null } | null)?.version ?? null;
  }

  // Enrich each sales-voucher job with ledger names + party (customer) details
  // so the bridge has everything it needs to build the Tally voucher.
  const ledgers = {
    rent_income:    settingsMap["tally_ledger_rent_income"]  ?? "",
    usage_income:   settingsMap["tally_ledger_usage_income"] ?? "",
    cgst:           settingsMap["tally_ledger_cgst_output"]  ?? "",
    sgst:           settingsMap["tally_ledger_sgst_output"]  ?? "",
    igst:           settingsMap["tally_ledger_igst_output"]  ?? "",
    round_off:      settingsMap["tally_ledger_round_off"]    ?? "",
  };
  const voucherSeries = settingsMap["tally_voucher_series"] ?? "SDIPL-REG";
  const partySuffix   = settingsMap["tally_party_ledger_suffix"] ?? "";
  const stockItem     = settingsMap["tally_stock_item"] ?? "Rent-The WorkVilla";
  const placeOfSupply = settingsMap["tally_place_of_supply"] ?? "Tamil Nadu";

  for (const job of jobs) {
    if (job.job_type !== "sales_voucher" || !job.billing_statement_id) continue;

    // Resolve the customer (party) + line items from the statement
    const { data: stmt } = await supabase
      .from("billing_statements")
      .select(`
        subtotal, line_items, statement_number,
        contract:contracts!billing_statements_contract_id_fkey(
          contract_number,
          lead:leads!contracts_lead_id_fkey(company, first_name, last_name, gst_number, state, street, city, zip_code)
        )
      `)
      .eq("id", job.billing_statement_id)
      .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractNumber = (stmt as any)?.contract?.contract_number as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statementNumber = (stmt as any)?.statement_number as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = (stmt as any)?.contract?.lead ?? {};
    const partyName = (lead.company as string | undefined)?.trim()
      || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()
      || "Walk-in Customer";

    // Flatten the statement's sectioned line_items into invoice lines
    // (one line per section: label + subtotal). Falls back to a single line.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sections = ((stmt as any)?.line_items as Array<{ label?: string; subtotal?: number }> | null) ?? [];
    let invoiceLines = sections
      .filter((s) => Number(s.subtotal ?? 0) > 0)
      .map((s) => ({ description: String(s.label ?? "Service"), amount: Number(s.subtotal ?? 0) }));
    if (invoiceLines.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = Number((stmt as any)?.subtotal ?? (job.payload as any)?.taxable_amount ?? 0);
      invoiceLines = [{ description: "Coworking Services", amount: sub }];
    }

    // Build a narration that identifies the source of this voucher for audit/reconciliation.
    // Format: "TWV CRM | Contract: TWV-CON-001 | Stmt: BS-2025-001 | Bridge: v1.1.0"
    const narrationParts = ["TWV CRM"];
    if (contractNumber) narrationParts.push(`Contract: ${contractNumber}`);
    if (statementNumber) narrationParts.push(`Stmt: ${statementNumber}`);
    if (bridgeVersion)   narrationParts.push(`Bridge: v${bridgeVersion}`);
    const narration = narrationParts.join(" | ");

    job.payload = {
      ...(job.payload as Record<string, unknown>),
      narration,
      party_ledger:  partySuffix ? `${partyName}${partySuffix}` : partyName,
      buyer_gstin:   (lead.gst_number as string | null) ?? "",
      buyer_state:   (lead.state as string | null) ?? "",
      buyer_address: [lead.street, lead.city, lead.zip_code].filter(Boolean).join(", "),
      line_items:    invoiceLines,                       // flattened for the bridge
      ledger_sales:    ledgers.rent_income || "Rent The Workvilla 18%",
      ledger_usage:    ledgers.usage_income || ledgers.rent_income || "Rent The Workvilla 18%",
      ledger_cgst:     ledgers.cgst || "CGST Output 9%",
      ledger_sgst:     ledgers.sgst || "SGST Output 9%",
      ledger_round_off: ledgers.round_off || "Round Off",
      voucher_series:  voucherSeries,
      stock_item:      stockItem,
      place_of_supply: placeOfSupply,
    };
  }

  // Enrich receipt-voucher jobs (reverse-sync: a CRM payment → Tally Receipt).
  // The enqueue payload already carries party_name, amount, invoice number, etc.;
  // here we add the resolved party ledger + the bank/cash ledger that receives the
  // money + a narration. The bank ledger is a single configured account
  // (tally_ledger_receipt_account) — the bridge fails loudly if it isn't set/known,
  // same as the party-ledger guard.
  const receiptAccount      = settingsMap["tally_ledger_receipt_account"] ?? "";
  const receiptVoucherSeries = settingsMap["tally_receipt_voucher_series"] ?? "Receipt";
  // Default ON: real receipts from this company knock the payment off the invoice
  // via Agst Ref (47/80 sampled). Set 'false' for plain on-account receipts.
  const receiptBillByBill   = settingsMap["tally_receipt_bill_by_bill"] !== "false";
  // Bank receipts carry a bank allocation (all 80 sampled). Default to treating the
  // receipt account as a bank; set tally_receipt_account_is_bank='false' for cash.
  const receiptIsBank       = settingsMap["tally_receipt_account_is_bank"] !== "false";
  const txnTypeDefault      = settingsMap["tally_receipt_transaction_type"] || "e-Fund Transfer";
  const transferModeDefault = settingsMap["tally_receipt_transfer_mode"] || "NEFT";
  for (const job of jobs) {
    if (job.job_type !== "receipt_voucher") continue;

    const payload = job.payload as Record<string, unknown>;
    const partyName = String(payload["party_name"] ?? "").trim() || "Walk-in Customer";
    const mode = String(payload["payment_mode"] ?? "");
    const ref  = String(payload["payment_reference"] ?? "");
    const inv  = String(payload["tally_invoice_number"] ?? "");

    const narrationParts = ["TWV CRM Receipt"];
    if (inv)  narrationParts.push(`Inv: ${inv}`);
    if (mode) narrationParts.push(`Mode: ${mode}`);
    if (ref)  narrationParts.push(`Ref: ${ref}`);
    if (bridgeVersion) narrationParts.push(`Bridge: v${bridgeVersion}`);

    job.payload = {
      ...payload,
      party_ledger:    partySuffix ? `${partyName}${partySuffix}` : partyName,
      receipt_ledger:  receiptAccount,           // bank/cash account that receives the money
      voucher_series:  receiptVoucherSeries,
      bill_by_bill:    receiptBillByBill,
      bank_allocation: receiptIsBank
        ? { transaction_type: txnTypeDefault, transfer_mode: transferModeDefault, reference: ref }
        : null,
      narration:       narrationParts.join(" | "),
    };
  }

  return NextResponse.json({
    jobs,
    tally_company_gstin: settingsMap["tally_company_gstin"] ?? "",
    lease_seconds: LEASE_SECONDS,
  });
}
