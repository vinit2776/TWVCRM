/**
 * POST /api/tally/ack
 *
 * Bridge-only endpoint. Called by the bridge after Tally has processed a job.
 *
 * Two outcomes:
 *   success = true  → invoice number + IRN received; write mirrors, create Razorpay link
 *   success = false → hard failure; mark job failed, update CRM dashboard flag
 *
 * Auth: Bearer TALLY_AGENT_TOKEN
 *
 * Body (success):
 * {
 *   job_id:               string
 *   success:              true
 *   tally_voucher_guid:   string
 *   tally_invoice_number: string
 *   tally_irn:            string
 *   tally_ack_no:         string
 *   tally_ack_date:       string
 *   tally_signed_qr_code: string
 *   tally_total_amount:   number   ← authoritative total; Razorpay link built from this
 *   irn_pending:          boolean  ← true if Tally created voucher but IRN not yet assigned
 *   voucher_created_at:   string   ← ISO timestamp; used for IRN-aging alarm
 * }
 *
 * Body (failure):
 * {
 *   job_id:   string
 *   success:  false
 *   error:    string   ← plain-English reason (IRP error, LINEERROR, etc.)
 *   retryable: boolean ← false = hard data error, needs human; true = transient
 * }
 *
 * Idempotent: acking the same job twice is safe (second call is a no-op).
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { runPostAckActions } from "@/lib/tally/post-ack";

const AckSuccessSchema = z.object({
  job_id:               z.string().uuid(),
  success:              z.literal(true),
  tally_voucher_guid:   z.string().min(1),
  tally_invoice_number: z.string().min(1),
  tally_irn:            z.string().optional(),       // may be absent if irn_pending=true
  tally_ack_no:         z.string().optional(),
  tally_ack_date:       z.string().optional(),
  tally_signed_qr_code: z.string().optional(),
  tally_total_amount:   z.number().positive(),
  irn_pending:          z.boolean().default(false),  // voucher created, IRN not yet assigned
  voucher_created_at:   z.string().optional(),
});

const AckFailureSchema = z.object({
  job_id:    z.string().uuid(),
  success:   z.literal(false),
  error:     z.string().min(1),
  retryable: z.boolean().default(false),
});

const AckSchema = z.discriminatedUnion("success", [AckSuccessSchema, AckFailureSchema]);

function authGuard(request: NextRequest): boolean {
  return request.headers.get("authorization") === `Bearer ${process.env.TALLY_AGENT_TOKEN}`;
}

export async function POST(request: NextRequest) {
  if (!authGuard(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = AckSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  const supabase = createAdminClient();

  // Fetch the job — must exist and be in a claimable state
  const { data: job, error: jobError } = await supabase
    .from("tally_sync_jobs")
    .select("id, status, billing_statement_id, gst_invoice_id, job_type, idempotency_key, attempt_count")
    .eq("id", data.job_id)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Idempotency: already completed → return success silently
  if (job.status === "completed") {
    return NextResponse.json({ ok: true, idempotent: true });
  }

  if (data.success) {
    // ── SUCCESS PATH ──────────────────────────────────────────────────────────

    const now = new Date().toISOString();
    const syncStatus = data.irn_pending ? "in_progress" : "issued";
    // 'in_progress' when voucher created but IRN not yet assigned (async IRN path).
    // The bridge will ack again once the IRN lands.

    // 1. Update the job
    await supabase
      .from("tally_sync_jobs")
      .update({
        status:               data.irn_pending ? "posted" : "completed",
        tally_voucher_guid:   data.tally_voucher_guid,
        tally_invoice_number: data.tally_invoice_number,
        tally_irn:            data.tally_irn ?? null,
        tally_ack_no:         data.tally_ack_no ?? null,
        tally_ack_date:       data.tally_ack_date ?? null,
        tally_signed_qr_code: data.tally_signed_qr_code ?? null,
        voucher_created_at:   data.voucher_created_at ?? now,
        completed_at:         data.irn_pending ? null : now,
      })
      .eq("id", data.job_id);

    // 2. Mirror onto billing_statement
    if (job.billing_statement_id) {
      await supabase
        .from("billing_statements")
        .update({
          tally_sync_status:    syncStatus,
          tally_invoice_number: data.tally_invoice_number,
          tally_voucher_guid:   data.tally_voucher_guid,
          tally_synced_at:      data.irn_pending ? null : now,
          tally_last_error:     null,
        })
        .eq("id", job.billing_statement_id);
    }

    // 3. Mirror onto gst_invoices (upsert by billing_statement_id if exists)
    if (job.gst_invoice_id && data.tally_irn) {
      await supabase
        .from("gst_invoices")
        .update({
          irn:                data.tally_irn,
          ack_no:             data.tally_ack_no ?? null,
          signed_qr_code:     data.tally_signed_qr_code ?? null,
          tally_voucher_guid: data.tally_voucher_guid,
          tally_synced_at:    now,
          sourced_from_tally: true,
          e_invoice_status:   "generated",
          e_invoice_generated_at: now,
        })
        .eq("id", job.gst_invoice_id);
    }

    // 4. Audit log
    void logAudit(supabase, {
      entityType:  "billing_statement" as const,
      entityId:    job.billing_statement_id ?? job.gst_invoice_id ?? data.job_id,
      action:      "update" as const,
      performedBy: "tally-bridge",
      changes: {
        tally_invoice_number: { old: null, new: data.tally_invoice_number },
        irn:                  { old: null, new: data.tally_irn ?? "pending" },
        total_amount:         { old: null, new: data.tally_total_amount },
      },
    });

    // Trigger post-ack actions (Razorpay link + PDF overlay) once IRN is confirmed.
    // When irn_pending=true, link creation is deferred until the bridge acks the IRN.
    if (!data.irn_pending && job.billing_statement_id) {
      void triggerPostAckActions(supabase, job.billing_statement_id, data);
    }

    return NextResponse.json({
      ok: true,
      next_step: data.irn_pending ? "create_razorpay_link_when_irn_ready" : "create_razorpay_link",
      tally_invoice_number: data.tally_invoice_number,
    });

  } else {
    // ── FAILURE PATH ──────────────────────────────────────────────────────────

    const now = new Date().toISOString();
    const isExhausted = (job.attempt_count ?? 0) >= ((job as { max_attempts?: number }).max_attempts ?? 5);
    const finalStatus = (!data.retryable || isExhausted) ? "failed" : "pending";

    await supabase
      .from("tally_sync_jobs")
      .update({
        status:     finalStatus,
        last_error: data.error,
        // If retryable: put back to pending so bridge retries automatically.
        // If hard failure: mark failed so it surfaces in the CRM for human attention.
        claimed_at:       null,
        lease_expires_at: null,
      })
      .eq("id", data.job_id);

    if (job.billing_statement_id) {
      await supabase
        .from("billing_statements")
        .update({
          tally_sync_status: finalStatus === "failed" ? "failed" : "pending",
          tally_last_error:  data.error,
        })
        .eq("id", job.billing_statement_id);
    }

    void logAudit(supabase, {
      entityType:  "billing_statement" as const,
      entityId:    job.billing_statement_id ?? data.job_id,
      action:      "update" as const,
      performedBy: "tally-bridge",
      changes: {
        tally_sync_status: { old: "in_progress", new: finalStatus },
        tally_last_error:  { old: null, new: data.error },
      },
    });

    return NextResponse.json({ ok: true, status: finalStatus });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-ack orchestration: Razorpay link + PDF overlay
// Runs fire-and-forget — never blocks the ack response.
// ─────────────────────────────────────────────────────────────────────────────
async function triggerPostAckActions(
  supabase: ReturnType<typeof createAdminClient>,
  billingStatementId: string,
  ackData: {
    tally_total_amount:   number;
    tally_invoice_number: string;
    tally_signed_qr_code?:string;
  }
): Promise<void> {
  try {
    // Fetch Razorpay credentials
    const { data: settings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);

    const creds = Object.fromEntries(
      (settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value])
    );

    if (creds["razorpay_enabled"] !== "true") {
      console.log(`[tally/ack] Razorpay not enabled — skipping link for ${billingStatementId}`);
      return;
    }

    // Fetch customer details + the statement total from the statement
    const { data: stmt } = await supabase
      .from("billing_statements")
      .select(`
        id, total_amount,
        contract:contracts!billing_statements_contract_id_fkey(
          lead:leads!contracts_lead_id_fkey(
            first_name, last_name, company, email, phone, mobile
          )
        )
      `)
      .eq("id", billingStatementId)
      .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = (stmt as any)?.contract?.lead ?? {};
    const customerName  = (lead.company as string | undefined)
      ?? `${(lead.first_name as string | undefined) ?? ""} ${(lead.last_name as string | undefined) ?? ""}`.trim()
      ?? "Customer";
    const customerEmail = (lead.email as string | null) ?? null;
    const customerPhone = ((lead.mobile as string | null) ?? (lead.phone as string | null)) ?? null;

    // Use Tally's total when provided (>0); on the IRN re-ack it's 0, so fall
    // back to the statement's authoritative total (they match — built from it).
    const statementTotal = Number((stmt as { total_amount?: number } | null)?.total_amount ?? 0);
    const linkAmount = ackData.tally_total_amount > 0 ? ackData.tally_total_amount : statementTotal;

    await runPostAckActions({
      supabase,
      billingStatementId,
      tallyInvoiceNumber: ackData.tally_invoice_number,
      tallyTotalAmount:   linkAmount,
      tallySignedQrCode:  ackData.tally_signed_qr_code ?? null,
      customerName,
      customerEmail,
      customerPhone,
      razorpayKeyId:     creds["razorpay_key_id"] ?? "",
      razorpayKeySecret: creds["razorpay_key_secret"] ?? "",
    });
  } catch (err) {
    console.error(`[tally/ack] post-ack error for ${billingStatementId}:`, err);
  }
}
