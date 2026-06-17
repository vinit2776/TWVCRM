import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";
import { isHandoffV2Enabled, setHandoffState } from "@/lib/tally-handoff-server";

/**
 * POST /api/billing-statements/[id]/upload-gst-invoice
 *
 * Accounts uploads the Tally GST invoice PDF for a statement that's in the
 * inbox. The endpoint:
 *   1. Validates the upload body (series + IRN rule, amount equality, mandatory fields)
 *   2. Stores the PDF in Supabase Storage (crm-documents bucket)
 *   3. Inserts a gst_invoice_uploads row (DB-level CHECK reinforces series-IRN pair)
 *   4. Mirrors number/IRN onto billing_statements (gst_invoice_number,
 *      tally_invoice_number, issuance_channel='tally')
 *   5. Transitions handoff_state to ready_to_send OR name_check_pending
 *
 * Hard-block rules (see docs/tally-handoff-redesign.md §8E):
 *   - Amount on PDF ≠ statement total → 422, no upload row inserted
 *   - A-series upload without IRN → 422
 *   - B-series upload with IRN → 422
 *   - Customer has GSTIN but B-series uploaded → 422
 *   - Customer has no GSTIN but A-series uploaded → 422
 */
export const dynamic = "force-dynamic";

interface UploadBody {
  tally_invoice_number: string;
  tally_invoice_series: "SDIPL-REG" | "SDIPL-UNREG";
  irn: string | null;
  invoice_date: string;
  invoice_amount: number;
  party_name_matches_contract: boolean;
  autofill_source: "qr" | "pdf_text" | "bridge_match" | "manual";
  qr_payload: Record<string, unknown> | null;
  nic_signature_verified: boolean;
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

  if (!(await isHandoffV2Enabled(supabase))) {
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

  // ── Fetch the statement + contract + lead so we can run the checks ──────
  const { data: statementRow, error: fetchErr } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, handoff_state, issuance_channel,
      contract:contracts!billing_statements_contract_id_fkey(
        id, billing_mode,
        lead:leads!contracts_lead_id_fkey(id, gst_number, first_name, last_name, company)
      )
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
    handoff_state: string | null;
    issuance_channel: string | null;
    contract: {
      id: string;
      billing_mode: "proforma_first" | "gst_direct" | null;
      lead: {
        id: string;
        gst_number: string | null;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
      } | null;
    } | null;
  };

  // ── Hard-block rules ──────────────────────────────────────────────────────
  if (Number(meta.invoice_amount).toFixed(2) !== Number(statement.total_amount).toFixed(2)) {
    return badRequest(
      `Tally amount ₹${meta.invoice_amount} does not match statement total ₹${statement.total_amount}. ` +
      `Fix the Tally voucher or void+reissue the statement; no override is allowed.`,
    );
  }

  const customerHasGstin = !!statement.contract?.lead?.gst_number;

  if (customerHasGstin && meta.tally_invoice_series !== "SDIPL-REG") {
    return badRequest(
      "Customer has GSTIN in CRM — must use A-series (SDIPL-REG) invoice with IRN.",
    );
  }
  if (!customerHasGstin && meta.tally_invoice_series !== "SDIPL-UNREG") {
    return badRequest(
      "Customer has no GSTIN in CRM — must use B-series (SDIPL-UNREG) invoice without IRN.",
    );
  }

  if (meta.tally_invoice_series === "SDIPL-REG") {
    if (!meta.irn || meta.irn.length !== 64) {
      return badRequest("A-series invoices require a 64-character IRN.");
    }
  } else {
    if (meta.irn) {
      return badRequest("B-series invoices must NOT carry an IRN.");
    }
  }

  // Series-vs-prefix sanity (A-series number must start with SD/A/…, etc.)
  const expectedPrefix = meta.tally_invoice_series === "SDIPL-REG" ? "SD/A/" : "SD/B/";
  if (!meta.tally_invoice_number.startsWith(expectedPrefix)) {
    return badRequest(
      `Invoice number "${meta.tally_invoice_number}" does not match expected ${expectedPrefix}* prefix for series ${meta.tally_invoice_series}.`,
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
  const safeNumber = meta.tally_invoice_number.replace(/[^\w-]/g, "_");
  const filePath = `tally-handoff/${statement.contract?.id ?? "unknown"}/${timestamp}-${safeNumber}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // ── Insert gst_invoice_uploads row ────────────────────────────────────────
  const nameCheckStatus = meta.party_name_matches_contract ? "approved" : "pending";

  const { data: insertedUpload, error: insertErr } = await supabase
    .from("gst_invoice_uploads")
    .insert({
      billing_statement_id: statement.id,
      uploaded_by: authUserId,
      tally_invoice_number: meta.tally_invoice_number,
      tally_invoice_series: meta.tally_invoice_series,
      irn: meta.irn,
      invoice_date: meta.invoice_date,
      invoice_amount: meta.invoice_amount,
      invoice_pdf_url: filePath,
      qr_payload: meta.qr_payload,
      autofill_source: meta.autofill_source,
      nic_signature_verified: meta.nic_signature_verified,
      name_check_status: nameCheckStatus,
      name_check_decided_by: meta.party_name_matches_contract ? authUserId : null,
      name_check_decided_at: meta.party_name_matches_contract ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── Mirror onto billing_statements + stamp issuance_channel='tally' ───────
  // D2 (decide once): once stamped, CRM will refuse to generate its own GST invoice.
  await supabase
    .from("billing_statements")
    .update({
      gst_invoice_number: meta.tally_invoice_number,
      tally_invoice_number: meta.tally_invoice_number,
      tally_total_amount: meta.invoice_amount,
      issuance_channel: "tally",
      tally_sync_status: "issued",
    })
    .eq("id", statement.id);

  // ── Transition handoff_state ─────────────────────────────────────────────
  const nextState = meta.party_name_matches_contract ? "ready_to_send" : "name_check_pending";
  await setHandoffState(supabase, statement.id, nextState, "gst_invoice_uploaded");

  return NextResponse.json({
    ok: true,
    upload_id: insertedUpload.id,
    handoff_state: nextState,
  });
}
