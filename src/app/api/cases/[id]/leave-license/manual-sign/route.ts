import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { checkVoExecutionPaymentGate } from "@/lib/vo-execution-gate";
import { advanceCaseOnAgreementExecuted } from "@/lib/case-status-events";

/**
 * POST: Upload a manually signed stamp-paper PDF and mark the L&L agreement as executed.
 *
 * Accepts multipart/form-data with:
 *   - file: the signed PDF
 *   - agreement_id: the case_agreements row id
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to upload signed documents" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const agreementId = formData.get("agreement_id") as string | null;

  if (!file || !agreementId) {
    return NextResponse.json({ error: "file and agreement_id are required" }, { status: 400 });
  }

  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File must be under 20 MB" }, { status: 400 });
  }

  // Verify the agreement exists and belongs to this case
  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, case_id")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  const allowedStatuses = ["client_approved", "signing", "internally_approved", "draft"];
  if (!allowedStatuses.includes(agreement.status)) {
    return NextResponse.json(
      { error: `Cannot upload a signed document when agreement is in '${agreement.status}' status` },
      { status: 400 }
    );
  }

  const gateError = await checkVoExecutionPaymentGate(supabase, caseId);
  if (gateError) {
    return NextResponse.json({ error: gateError }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `case-agreements/${caseId}/manual-signed-leave-license-${Date.now()}.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, fileBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "Storage upload failed: " + uploadError.message },
      { status: 500 }
    );
  }

  // Create a document record for the signed PDF
  const { data: docRecord } = await adminSupabase
    .from("documents")
    .insert({
      title: `Leave & License Agreement — Manually Signed`,
      file_name: file.name || "manual-signed-leave-license.pdf",
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: fileBuffer.length,
      category: "case_document",
      uploaded_by: dbUser.id,
    })
    .select("id")
    .single();

  // Update the agreement: mark executed, store the signed document reference
  const { data: updated, error: updateErr } = await supabase
    .from("case_agreements")
    .update({
      status: "executed",
      signed_at: new Date().toISOString(),
      // Store signed document as the new generated_document_id so it shows in the tab
      generated_document_id: docRecord?.id,
    })
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Sync case status
  if (updated) {
    await supabase
      .from("cases")
      .update({ ll_agreement_status: "executed" })
      .eq("id", caseId);

    await advanceCaseOnAgreementExecuted(supabase, caseId);
  }

  logAudit(supabase, {
    entityType: "case_agreement",
    entityId: agreementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "manual_sign_upload" },
      status: { old: agreement.status, new: "executed" },
      signed_document: { old: null, new: storagePath },
    },
  });

  return NextResponse.json({ data: updated });
}
