/**
 * POST /api/admin/tally/redispatch
 *
 * One-shot admin endpoint to re-send a Tally-issued invoice PDF.
 * Clears tally_delivered_at (the delivered-once gate) and re-triggers
 * dispatchTallyInvoice with the IRN and signed QR code stored in the
 * latest completed tally_sync_job for the statement.
 *
 * Used when the original dispatch happened before the IRN/QR code was
 * available (e.g. async IRN path) and the corrected invoice needs to be
 * re-sent with those fields.
 *
 * Auth: admin role only (cookie session).
 *
 * Body: { billing_statement_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchTallyInvoice } from "@/lib/tally/dispatch-tally-invoice";

export async function POST(request: NextRequest) {
  // ── Auth: admin only ──────────────────────────────────────────────────────
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await userClient
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: { billing_statement_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { billing_statement_id } = body;
  if (!billing_statement_id) {
    return NextResponse.json({ error: "billing_statement_id required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Fetch statement to get tally fields ──────────────────────────────────────
  const { data: stmtMeta } = await supabase
    .from("billing_statements")
    .select("tally_invoice_number, total_amount")
    .eq("id", billing_statement_id)
    .single();

  type JobRow = { id: string; status: string; tally_invoice_number: string | null; tally_irn: string | null; tally_signed_qr_code: string | null; tally_total_amount: number | null };
  let job: JobRow | null = null;

  // ── Path 1: by billing_statement_id (any status) ──────────────────────────
  const { data: jobByStmt } = await supabase
    .from("tally_sync_jobs")
    .select("id, status, tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount")
    .eq("billing_statement_id", billing_statement_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  job = (jobByStmt as JobRow | null) ?? null;

  // ── Path 2: by tally_invoice_number (any status) ──────────────────────────
  if (!job && stmtMeta?.tally_invoice_number) {
    const { data: jobByInvNum } = await supabase
      .from("tally_sync_jobs")
      .select("id, status, tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount")
      .eq("tally_invoice_number", stmtMeta.tally_invoice_number)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    job = (jobByInvNum as JobRow | null) ?? null;
  }

  if (!job) {
    return NextResponse.json({
      error: "No tally_sync_job found for this statement (tried billing_statement_id and tally_invoice_number)",
      billing_statement_id,
      tally_invoice_number: stmtMeta?.tally_invoice_number ?? null,
    }, { status: 404 });
  }

  // Allow re-dispatch regardless of job status — the IRN data may be on any job row.

  // ── Clear the delivered-once gate ─────────────────────────────────────────
  const { error: clearErr } = await supabase
    .from("billing_statements")
    .update({ tally_delivered_at: null })
    .eq("id", billing_statement_id);

  if (clearErr) {
    return NextResponse.json({ error: `Failed to clear gate: ${clearErr.message}` }, { status: 500 });
  }

  // ── Resolve total_amount (may be 0 on IRN-only job) ───────────────────────
  let totalAmount = Number(job.tally_total_amount ?? 0);
  if (totalAmount === 0) {
    const { data: stmt } = await supabase
      .from("billing_statements")
      .select("total_amount")
      .eq("id", billing_statement_id)
      .single();
    totalAmount = Number(stmt?.total_amount ?? 0);
  }

  // ── Re-dispatch ───────────────────────────────────────────────────────────
  const result = await dispatchTallyInvoice(supabase, billing_statement_id, {
    invoiceNumber:  job.tally_invoice_number as string,
    totalAmount,
    signedQrCode:   job.tally_signed_qr_code as string | null,
    irn:            job.tally_irn as string | null,
  });

  return NextResponse.json({
    ok: result.ok,
    emailedTo:      result.emailedTo,
    razorpayLinkUrl: result.razorpayLinkUrl,
    error:          result.error,
  });
}
