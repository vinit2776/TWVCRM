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

  // ── Fetch statement to get tally_invoice_number as fallback key ─────────────
  const { data: stmtMeta } = await supabase
    .from("billing_statements")
    .select("tally_invoice_number, total_amount")
    .eq("id", billing_statement_id)
    .single();

  // ── Fetch latest completed sync job — primary: by billing_statement_id ──────
  let job: { tally_invoice_number: string | null; tally_irn: string | null; tally_signed_qr_code: string | null; tally_total_amount: number | null } | null = null;

  const { data: jobByStmt } = await supabase
    .from("tally_sync_jobs")
    .select("tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount")
    .eq("billing_statement_id", billing_statement_id)
    .in("status", ["completed", "posted"])   // posted = voucher exists, IRN may be pending
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();

  job = jobByStmt ?? null;

  // ── Fallback: find by tally_invoice_number stored on the statement ───────────
  if (!job && stmtMeta?.tally_invoice_number) {
    const { data: jobByInvNum } = await supabase
      .from("tally_sync_jobs")
      .select("tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount")
      .eq("tally_invoice_number", stmtMeta.tally_invoice_number)
      .in("status", ["completed", "posted"])
      .order("completed_at", { ascending: false })
      .limit(1)
      .single();
    job = jobByInvNum ?? null;
  }

  if (!job) {
    return NextResponse.json({
      error: "No completed tally_sync_job found for this statement",
      billing_statement_id,
      tally_invoice_number: stmtMeta?.tally_invoice_number ?? null,
    }, { status: 404 });
  }

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
