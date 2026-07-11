import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { logAudit } from "@/lib/audit";

/**
 * GET  /api/tds/receivable/[paymentId]/certificate — signed download URL for an uploaded certificate
 * POST /api/tds/receivable/[paymentId]/certificate — upload/replace the certificate for a TDS deduction
 *
 * Optional, for-reference-only attachment (e.g. Form 16A the client sends).
 * Never required to settle the payment — settlement already happens off
 * tds_amount at record-payment time (see billing-statements/[id]/payment).
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: payment } = await supabase
    .from("billing_payments")
    .select("id, tds_certificate_path")
    .eq("id", paymentId)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (!payment.tds_certificate_path) {
    return NextResponse.json({ error: "No certificate uploaded for this deduction" }, { status: 404 });
  }

  const { data: signedUrl, error: signedError } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(payment.tds_certificate_path, 3600);

  if (signedError || !signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.json({ data: { download_url: signedUrl.signedUrl } });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> }
) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can upload TDS certificates" }, { status: 403 });
  }

  const { data: payment } = await supabase
    .from("billing_payments")
    .select("id, tds_amount, billing_statement_id")
    .eq("id", paymentId)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (!payment.tds_amount || Number(payment.tds_amount) <= 0) {
    return NextResponse.json({ error: "This payment has no TDS deduction recorded" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ error: "Only PDF, JPEG, or PNG files are allowed" }, { status: 400 });
  }

  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const filePath = `tds-certificates/${paymentId}/${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // billing_payments has no UPDATE RLS policy for authenticated users
  // (INSERT-only, by design) — the write must go through the admin client.
  const adminClient = await createAdminClient();
  const { data: updated, error: updateError } = await adminClient
    .from("billing_payments")
    .update({ tds_certificate_path: filePath })
    .eq("id", paymentId)
    .select("id, tds_certificate_path")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { data: signedUrl } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(filePath, 3600);

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: payment.billing_statement_id,
    action: "update",
    performedBy: dbUser.id,
    changes: { tds_certificate_uploaded: { old: null, new: `payment:${paymentId} path:${filePath}` } },
  });

  return NextResponse.json({ data: updated, download_url: signedUrl?.signedUrl || null });
}
