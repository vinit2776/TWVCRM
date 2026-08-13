import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/upload-credit-note
 *
 * Manual replacement for the dead cancel-tally / enqueueTallyCreditNote path
 * (that one depends on the shelved automated Tally bridge-sync — see
 * src/lib/tally/enqueue.ts — which is off in production). Mirrors the manual
 * upload-gst-invoice flow: the accountant creates the Credit Note in Tally
 * themselves, then uploads the resulting number/date/amount/PDF here.
 *
 *   1. Validates the upload (full-amount match, series/prefix rule)
 *   2. Stores the PDF in Supabase Storage (crm-documents bucket)
 *   3. Inserts a credit_note_uploads row
 *   4. Cancels any live Razorpay payment link on the statement
 *   5. Marks the statement voided + lifecycle_stage='cancelled', mirrors
 *      tally_credit_note_number onto billing_statements
 *   6. Unlinks usage_charges/bookings/service_usage_records so they can be
 *      re-billed (mirrors /void)
 *
 * Only applies to statements already issued via Tally (issuance_channel
 * === 'tally'). Statements that haven't reached Tally yet should use the
 * normal /void endpoint instead.
 *
 * Full-amount cancellation only — no partial credit notes.
 */
export const dynamic = "force-dynamic";

const RAZORPAY_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

interface UploadBody {
  credit_note_number: string;
  credit_note_date: string;
  credit_note_amount: number;
  reason: string;
}

function badRequest(reason: string) {
  return NextResponse.json({ error: reason }, { status: 422 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const authUserId = user.id;
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json(
      { error: "Tally handoff v2 is not enabled. Enable the feature flag first." },
      { status: 409 },
    );
  }

  // ── Parse multipart form ─────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Could not parse upload");
  }

  const file = formData.get("file") as File | null;
  const metaRaw = formData.get("meta") as string | null;
  if (!file) return badRequest("No file provided");
  if (!metaRaw) return badRequest("No upload metadata provided");

  let meta: UploadBody;
  try {
    meta = JSON.parse(metaRaw) as UploadBody;
  } catch {
    return badRequest("Invalid meta JSON");
  }

  if (!meta.credit_note_number?.trim()) return badRequest("Credit note number is required.");
  if (!meta.credit_note_date) return badRequest("Credit note date is required.");
  if (!meta.reason?.trim() || meta.reason.trim().length < 5) {
    return badRequest("A cancellation reason (min 5 chars) is required.");
  }

  // ── Fetch the statement + all 5 possible sources ─────────────────────────
  const { data: statementRow, error: fetchErr } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, status, issuance_channel, lifecycle_stage,
      statement_number, tally_invoice_number, razorpay_payment_link_id, notes,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, gst_number, first_name, last_name, company, email)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, gst_number, first_name, last_name, company, email)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, gst_number, first_name, last_name, company, email)
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, bill_to, client_name, client_company_name, client_email, client_gst_number,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, gst_number)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, gst_number)
    `)
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !statementRow) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  const statement = statementRow as unknown as {
    id: string;
    total_amount: number;
    payment_status: string;
    status: string;
    issuance_channel: string | null;
    lifecycle_stage: string | null;
    statement_number: string | null;
    tally_invoice_number: string | null;
    razorpay_payment_link_id: string | null;
    notes: string | null;
    contract: { id: string; contract_number: string | null; lead: { id: string; gst_number: string | null; first_name: string | null; last_name: string | null; company: string | null; email: string | null } | null } | null;
    proposal: { id: string; proposal_number: string | null; lead: { id: string; gst_number: string | null; first_name: string | null; last_name: string | null; company: string | null; email: string | null } | null } | null;
    invoice: { id: string; invoice_number: string | null; lead: { id: string; gst_number: string | null; first_name: string | null; last_name: string | null; company: string | null; email: string | null } | null } | null;
    case: {
      id: string; case_number: string; bill_to: "aggregator" | "client" | null;
      client_name: string; client_company_name: string | null; client_email: string | null; client_gst_number: string | null;
      aggregator: { id: string; name: string; primary_email: string | null; gst_number: string | null } | null;
    } | null;
    aggregator: { id: string; name: string; primary_email: string | null; gst_number: string | null } | null;
  };

  // ── Guards ─────────────────────────────────────────────────────────────
  if (statement.issuance_channel !== "tally" || !statement.tally_invoice_number) {
    return NextResponse.json(
      { error: "This statement was not issued by Tally. Use the normal void action instead." },
      { status: 400 },
    );
  }
  if (statement.status === "voided") {
    return NextResponse.json({ error: "Statement is already voided." }, { status: 409 });
  }
  if (statement.lifecycle_stage === "cancelled") {
    return NextResponse.json({ error: "A credit note has already been recorded for this invoice." }, { status: 409 });
  }

  /** Synthesizes the same lead-like shape used elsewhere in this route from a
   *  VO case or aggregator-consolidated statement — mirrors leadFromVoSource
   *  in upload-gst-invoice/route.ts. */
  function leadFromVoSource(s: typeof statement) {
    if (s.case) {
      const billToAggregator = s.case.bill_to === "aggregator" ? s.case.aggregator : null;
      if (billToAggregator) {
        return {
          id: billToAggregator.id, gst_number: billToAggregator.gst_number,
          first_name: null, last_name: null, company: billToAggregator.name, email: billToAggregator.primary_email,
        };
      }
      return {
        id: s.case.id, gst_number: s.case.client_gst_number,
        first_name: null, last_name: null, company: s.case.client_company_name ?? s.case.client_name, email: s.case.client_email,
      };
    }
    if (s.aggregator) {
      return {
        id: s.aggregator.id, gst_number: s.aggregator.gst_number,
        first_name: null, last_name: null, company: s.aggregator.name, email: s.aggregator.primary_email,
      };
    }
    return null;
  }

  const partyId = statement.contract?.id ?? statement.proposal?.id ?? statement.invoice?.id ?? statement.case?.id ?? statement.aggregator?.id ?? "unknown";
  const partyLead = statement.contract?.lead ?? statement.proposal?.lead ?? statement.invoice?.lead ?? leadFromVoSource(statement);

  // ── Full-amount match only — no partial credit notes ─────────────────────
  if (Math.round(Number(meta.credit_note_amount)) !== Math.round(Number(statement.total_amount))) {
    return badRequest(
      `Credit note ₹${meta.credit_note_amount} does not match statement total ₹${statement.total_amount}. ` +
      `Partial credit notes are not supported — the full invoice amount must be credited.`,
    );
  }

  // ── Series/prefix validation, derived from the customer's GSTIN status ───
  // Only the A-series ("CN/A/...") prefix has a verified real format — the
  // B-series is soft-checked (must start with "CN/") until confirmed.
  const customerHasGstin = !!partyLead?.gst_number;
  const originalInvoiceSeries = customerHasGstin ? "SDIPL-REG" : "SDIPL-UNREG";
  const creditNoteSeries = customerHasGstin ? "CREDIT NOTE-REG" : "CREDIT NOTE-UNREG";
  const expectedPrefix = customerHasGstin ? "CN/A/" : "CN/";
  if (!meta.credit_note_number.startsWith(expectedPrefix)) {
    return badRequest(
      `Credit note number "${meta.credit_note_number}" does not match expected ${expectedPrefix}* prefix for this customer.`,
    );
  }

  // ── Normalize + upload the PDF ────────────────────────────────────────────
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  if (!allowedTypes.includes(file.type)) {
    return badRequest("Only PDF / JPEG / PNG files are allowed.");
  }

  let normalized: { buffer: Buffer; mimeType: string; ext: string };
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (normalized.mimeType === "application/pdf") {
    normalized.buffer = await stampSignatureOnPdf(normalized.buffer);
  }

  const timestamp = Date.now();
  const safeNumber = meta.credit_note_number.replace(/[^\w-]/g, "_");
  const filePath = `tally-handoff/${partyId}/credit-notes/${timestamp}-${safeNumber}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // ── Insert credit_note_uploads row ────────────────────────────────────────
  const { data: insertedUpload, error: insertErr } = await supabase
    .from("credit_note_uploads")
    .insert({
      billing_statement_id: statement.id,
      uploaded_by: authUserId,
      original_invoice_number: statement.tally_invoice_number,
      original_invoice_series: originalInvoiceSeries,
      credit_note_number: meta.credit_note_number,
      credit_note_series: creditNoteSeries,
      credit_note_date: meta.credit_note_date,
      credit_note_amount: meta.credit_note_amount,
      credit_note_pdf_url: filePath,
      reason: meta.reason,
    })
    .select("id")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── Cancel any live Razorpay payment link (ported from convert-to-gst-early) ─
  const existingLinkId = statement.razorpay_payment_link_id;
  if (existingLinkId) {
    const { data: rzpRows } = await adminClient
      .from("app_settings").select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
    const rzp = (rzpRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => {
      m[r.key] = r.value; return m;
    }, {});
    const rzpEnabled = rzp.razorpay_enabled === "true" && !!rzp.razorpay_key_id && !!rzp.razorpay_key_secret;
    if (rzpEnabled) {
      try {
        const rzpAuth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
        await withTimeout(
          fetch(`https://api.razorpay.com/v1/payment_links/${existingLinkId}/cancel`, {
            method: "POST",
            headers: { Authorization: `Basic ${rzpAuth}` },
          }),
          RAZORPAY_TIMEOUT_MS,
          "Razorpay cancel link",
        );
      } catch (err) {
        console.error("[upload-credit-note] Razorpay cancel failed (non-blocking):", err);
      }
    }
  }

  // ── Mark the statement voided + cancelled via credit note ─────────────────
  const now = new Date();
  const nowIso = now.toISOString();
  const nowYmd = nowIso.slice(0, 10);

  const { error: mirrorErr } = await adminClient
    .from("billing_statements")
    .update({
      status: "voided",
      voided_at: nowIso,
      voided_by: dbUser.id,
      void_reason: meta.reason,
      lifecycle_stage: "cancelled",
      tally_credit_note_number: meta.credit_note_number,
      tally_credit_note_guid: null,
      tally_last_error: null,
      razorpay_payment_link_id: null,
      razorpay_payment_link_url: null,
      notes: [
        statement.notes,
        `--- CANCELLED VIA CREDIT NOTE ${nowYmd} ---`,
        `Credit note ${meta.credit_note_number}. Reason: ${meta.reason}`,
      ].filter(Boolean).join("\n"),
    })
    .eq("id", statement.id);

  if (mirrorErr) {
    return NextResponse.json(
      { error: `Credit note saved (id: ${insertedUpload.id}) but marking the statement voided failed: ${mirrorErr.message}. Refresh and check statement state.` },
      { status: 500 },
    );
  }

  // ── Unlink usage_charges / bookings / service_usage_records ───────────────
  // Mirrors /void — no-op for case/aggregator/proposal/invoice-sourced
  // statements, matters for contract-sourced ones.
  await supabase.from("usage_charges")
    .update({ billing_statement_id: null, status: "pending" }).eq("billing_statement_id", statement.id);
  await supabase.from("bookings")
    .update({ billing_statement_id: null }).eq("billing_statement_id", statement.id);
  await supabase.from("service_usage_records")
    .update({ billing_statement_id: null, is_billed: false }).eq("billing_statement_id", statement.id);

  void logAudit(supabase, {
    entityType: "billing_statement",
    entityId: statement.id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: statement.status, new: "voided" },
      lifecycle_stage: { old: statement.lifecycle_stage, new: "cancelled" },
      tally_credit_note_number: { old: null, new: meta.credit_note_number },
    },
  });

  return NextResponse.json({
    ok: true,
    upload_id: insertedUpload.id,
    tally_credit_note_number: meta.credit_note_number,
    statement_status: "voided",
  });
}
