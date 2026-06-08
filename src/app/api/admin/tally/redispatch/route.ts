/**
 * POST /api/admin/tally/redispatch
 *
 * One-shot admin endpoint to re-send a Tally-issued invoice PDF.
 * Clears tally_delivered_at (the delivered-once gate) and re-triggers
 * dispatchTallyInvoice with the best IRN + signed QR code available.
 *
 * IRN source priority:
 *   1. Body override (irn / signed_qr_code fields — explicit manual pass-in)
 *   2. tally_sync_jobs — job with highest-priority IRN data for this statement
 *      (ordered: has_irn DESC, created_at DESC)
 *   3. gst_invoices table linked to the billing statement
 *
 * Auth: admin role only (cookie session).
 *
 * Body: {
 *   billing_statement_id: string
 *   irn?:           string   // manual override — use when DB lookup fails
 *   signed_qr_code?: string  // manual override — IRP signed JWT payload
 * }
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
  let body: { billing_statement_id?: string; irn?: string; signed_qr_code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { billing_statement_id, irn: irnOverride, signed_qr_code: qrOverride } = body;
  if (!billing_statement_id) {
    return NextResponse.json({ error: "billing_statement_id required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Fetch billing statement (tally fields only — avoids nullable FK issues) ──
  const { data: stmt, error: stmtErr } = await supabase
    .from("billing_statements")
    .select("tally_invoice_number, total_amount")
    .eq("id", billing_statement_id)
    .single();

  if (stmtErr || !stmt) {
    return NextResponse.json({ error: `Billing statement not found: ${stmtErr?.message ?? "unknown"}` }, { status: 404 });
  }

  if (!stmt.tally_invoice_number) {
    return NextResponse.json({ error: "Billing statement has no tally_invoice_number — has it been synced to Tally?" }, { status: 400 });
  }

  // ── Collect ALL jobs for this statement (any status) ─────────────────────
  // Order by: jobs with IRN data first, then newest first
  type JobRow = {
    id: string; status: string;
    tally_invoice_number: string | null;
    tally_irn: string | null;
    tally_signed_qr_code: string | null;
    tally_total_amount: number | null;
    gst_invoice_id: string | null;
  };

  // ── Path 1: jobs linked by billing_statement_id ──────────────────────────
  let jobs: JobRow[] = [];
  const { data: jobsByStmt } = await supabase
    .from("tally_sync_jobs")
    .select("id, status, tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount, gst_invoice_id")
    .eq("billing_statement_id", billing_statement_id)
    .order("created_at", { ascending: false });
  if (jobsByStmt?.length) jobs = jobsByStmt as JobRow[];

  // ── Path 2: fallback — jobs linked by invoice number ─────────────────────
  if (!jobs.length) {
    const { data: jobsByNum } = await supabase
      .from("tally_sync_jobs")
      .select("id, status, tally_invoice_number, tally_irn, tally_signed_qr_code, tally_total_amount, gst_invoice_id")
      .eq("tally_invoice_number", stmt.tally_invoice_number)
      .order("created_at", { ascending: false });
    if (jobsByNum?.length) jobs = jobsByNum as JobRow[];
  }

  // ── Check gst_invoices for IRN via gst_invoice_id on the job ─────────────
  let gstIrn: string | null = null;
  let gstQr: string | null = null;
  const gstInvoiceId = jobs.find(j => j.gst_invoice_id)?.gst_invoice_id ?? null;
  if (gstInvoiceId) {
    const { data: gstInv } = await supabase
      .from("gst_invoices")
      .select("irn, signed_qr_code")
      .eq("id", gstInvoiceId)
      .single();
    gstIrn = gstInv?.irn ?? null;
    gstQr = gstInv?.signed_qr_code ?? null;
  }

  // ── Pick best IRN source ──────────────────────────────────────────────────
  // Priority: body override → job with IRN → gst_invoices → null
  const bestJobWithIrn = jobs.find(j => j.tally_irn);
  const resolvedIrn: string | null =
    irnOverride                          ||
    bestJobWithIrn?.tally_irn            ||
    gstIrn                               ||
    null;
  const resolvedQr: string | null =
    qrOverride                           ||
    bestJobWithIrn?.tally_signed_qr_code ||
    gstQr                                ||
    null;

  // Use the invoice number from the most recent job (or from the statement)
  const invoiceNumber = jobs[0]?.tally_invoice_number ?? stmt.tally_invoice_number;

  // ── Clear the delivered-once gate ─────────────────────────────────────────
  await supabase
    .from("billing_statements")
    .update({ tally_delivered_at: null })
    .eq("id", billing_statement_id);

  // ── Resolve total_amount ──────────────────────────────────────────────────
  let totalAmount = Number(jobs[0]?.tally_total_amount ?? 0);
  if (totalAmount === 0) totalAmount = Number(stmt.total_amount ?? 0);

  // ── Re-dispatch ───────────────────────────────────────────────────────────
  const result = await dispatchTallyInvoice(supabase, billing_statement_id, {
    invoiceNumber,
    totalAmount,
    signedQrCode: resolvedQr,
    irn:          resolvedIrn,
  });

  return NextResponse.json({
    ok:              result.ok,
    emailedTo:       result.emailedTo,
    razorpayLinkUrl: result.razorpayLinkUrl,
    error:           result.error,
    // Debug: show where the IRN came from so we can diagnose
    debug: {
      irn_source:        irnOverride ? "body_override" : (bestJobWithIrn ? "tally_sync_job" : (gstIrn ? "gst_invoices" : "none")),
      irn_found:         !!resolvedIrn,
      qr_found:          !!resolvedQr,
      jobs_checked:      jobs.length,
      jobs_with_irn:     jobs.filter(j => j.tally_irn).length,
      job_statuses:      jobs.map(j => ({ id: j.id, status: j.status, has_irn: !!j.tally_irn })),
      gst_invoice_id:    gstInvoiceId,
      gst_irn_found:     !!gstIrn,
    },
  });
}
