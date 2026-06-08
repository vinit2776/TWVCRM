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
import { dispatchTallyInvoice } from "@/lib/tally/dispatch-tally-invoice";

const AckSuccessSchema = z.object({
  job_id:               z.string().uuid(),
  success:              z.literal(true),
  voucher_kind:         z.enum(["sales", "receipt", "credit_note"]).default("sales"),
  tally_voucher_guid:   z.string().min(1),
  tally_invoice_number: z.string().min(1),
  tally_irn:            z.string().optional(),       // may be absent if irn_pending=true
  tally_ack_no:         z.string().optional(),
  tally_ack_date:       z.string().optional(),
  tally_signed_qr_code: z.string().optional(),
  tally_total_amount:   z.number().min(0),   // 0 = IRN-only ack (total already stored from initial ack)
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
    .select("id, status, billing_statement_id, gst_invoice_id, job_type, idempotency_key, attempt_count, payload")
    .eq("id", data.job_id)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Idempotency: already completed → return success silently
  if (job.status === "completed") {
    return NextResponse.json({ ok: true, idempotent: true });
  }

  // ── RECEIPT-VOUCHER ACK ─────────────────────────────────────────────────────
  // A receipt is the reverse-sync of a payment, not an invoice. Mark the job done
  // and mirror the Tally receipt number onto billing_payments. Do NOT touch the
  // statement's issuance fields and do NOT trigger invoice delivery.
  if (data.success && data.voucher_kind === "receipt") {
    const now = new Date().toISOString();

    await supabase
      .from("tally_sync_jobs")
      .update({
        status:               "completed",
        tally_voucher_guid:   data.tally_voucher_guid,
        tally_invoice_number: data.tally_invoice_number,   // the Receipt voucher number
        completed_at:         now,
      })
      .eq("id", data.job_id);

    const paymentId = (job.payload as { payment_id?: string } | null)?.payment_id;
    if (paymentId) {
      await supabase
        .from("billing_payments")
        .update({
          tally_receipt_number:       data.tally_invoice_number,
          tally_receipt_voucher_guid: data.tally_voucher_guid,
          tally_receipt_synced_at:    now,
        })
        .eq("id", paymentId);
    }

    void logAudit(supabase, {
      entityType:  "billing_statement" as const,
      entityId:    job.billing_statement_id ?? data.job_id,
      action:      "update" as const,
      performedBy: "tally-bridge",
      changes: {
        tally_receipt_number: { old: null, new: data.tally_invoice_number },
        receipt_amount:       { old: null, new: data.tally_total_amount },
      },
    });

    return NextResponse.json({ ok: true, voucher_kind: "receipt", tally_receipt_number: data.tally_invoice_number });
  }

  // ── CREDIT-NOTE ACK (CRM-first cancel confirmed by Tally) ────────────────────
  // Tally posted the reversing credit note. NOW it's safe to void the CRM statement
  // (Tally reversed first → books in sync) and free its charges for re-billing.
  if (data.success && data.voucher_kind === "credit_note" && job.billing_statement_id) {
    const now = new Date().toISOString();
    const reason = (job.payload as { reason?: string } | null)?.reason ?? "Cancelled via Tally credit note";
    const stmtId = job.billing_statement_id;

    await supabase.from("tally_sync_jobs").update({
      status:               "completed",
      tally_voucher_guid:   data.tally_voucher_guid,
      tally_invoice_number: data.tally_invoice_number,   // the Credit Note number
      completed_at:         now,
    }).eq("id", data.job_id);

    await supabase.from("billing_statements").update({
      status:                   "voided",
      voided_at:                now,
      void_reason:              reason,
      lifecycle_stage:          "cancelled",
      tally_credit_note_number: data.tally_invoice_number,
      tally_credit_note_guid:   data.tally_voucher_guid,
      tally_last_error:         null,
    }).eq("id", stmtId);

    // Free the charges so they can be re-billed (mirrors the CRM void flow).
    await supabase.from("usage_charges")
      .update({ billing_statement_id: null, status: "pending" }).eq("billing_statement_id", stmtId);
    await supabase.from("bookings")
      .update({ billing_statement_id: null }).eq("billing_statement_id", stmtId);
    await supabase.from("service_usage_records")
      .update({ billing_statement_id: null, is_billed: false }).eq("billing_statement_id", stmtId);

    void logAudit(supabase, {
      entityType:  "billing_statement" as const,
      entityId:    stmtId,
      action:      "update" as const,
      performedBy: "tally-bridge",
      changes: {
        status:                   { old: "exported", new: "voided" },
        tally_credit_note_number: { old: null, new: data.tally_invoice_number },
      },
    });

    return NextResponse.json({ ok: true, voucher_kind: "credit_note", tally_credit_note_number: data.tally_invoice_number });
  }

  if (data.success) {
    // ── SUCCESS PATH (sales voucher) ────────────────────────────────────────────

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
      // tally_total_amount=0 means this is an IRN-only ack (second ack after async IRN).
      // The total was already written during the initial voucher-creation ack — don't overwrite with 0.
      const statementUpdate: Record<string, unknown> = {
        tally_sync_status:    syncStatus,
        tally_invoice_number: data.tally_invoice_number,
        tally_voucher_guid:   data.tally_voucher_guid,
        tally_synced_at:      data.irn_pending ? null : now,
        lifecycle_stage:      data.irn_pending ? "awaiting_irn" : "issued",
        tally_last_error:     null,
      };
      // OV3: mirror Tally's authoritative total only when we actually have it.
      if (data.tally_total_amount > 0) {
        statementUpdate.total_amount = data.tally_total_amount;
      }
      await supabase
        .from("billing_statements")
        .update(statementUpdate)
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

    // Deliver the invoice (PDF + email + Razorpay link for unpaid) once the
    // invoice is fully issued. When irn_pending=true the B2B invoice has no IRN
    // yet — delivery is deferred until the bridge acks again with the IRN.
    // dispatchTallyInvoice is delivered-once gated, so a duplicate ack is safe.
    if (!data.irn_pending && job.billing_statement_id) {
      // For IRN-only acks (tally_total_amount=0), look up the stored total from the statement.
      let totalAmount = data.tally_total_amount;
      if (totalAmount === 0) {
        const { data: stmt } = await supabase
          .from("billing_statements")
          .select("total_amount")
          .eq("id", job.billing_statement_id)
          .single();
        totalAmount = stmt?.total_amount ?? 0;
      }
      void dispatchTallyInvoice(supabase, job.billing_statement_id, {
        invoiceNumber: data.tally_invoice_number,
        totalAmount,
        signedQrCode:  data.tally_signed_qr_code ?? null,
        irn:           data.tally_irn ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      next_step: data.irn_pending ? "create_razorpay_link_when_irn_ready" : "create_razorpay_link",
      tally_invoice_number: data.tally_invoice_number,
    });

  } else {
    // ── FAILURE PATH ──────────────────────────────────────────────────────────

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
