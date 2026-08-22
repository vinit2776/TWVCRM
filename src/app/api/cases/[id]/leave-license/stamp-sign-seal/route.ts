import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generateLeaveLicensePdf, type LeaveLicenseVariables } from "@/lib/leave-license-generator";
import { generateStampReference } from "@/lib/company-stamp";
import { checkVoExecutionPaymentGate } from "@/lib/vo-execution-gate";
import { advanceCaseOnAgreementExecuted } from "@/lib/case-status-events";

const PRE_EXECUTED_STATUSES = [
  "draft",
  "internally_approved",
  "sent_to_client",
  "client_approved",
  "signing",
];

/**
 * POST /api/cases/[id]/leave-license/stamp-sign-seal
 *
 * Admin-only manual/offline alternative to Leegality: regenerates the
 * Leave & License agreement PDF from its stored variables with TWV's
 * signature and seal embedded in the Lessor signature cell, then marks the
 * agreement executed. Does not touch the Leegality e-sign flow.
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

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can stamp the sign & seal" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const agreementId = body?.agreement_id as string | undefined;
  const previewedStampRef = body?.stampRef as string | undefined;
  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, signed_document_id, variables")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  if (agreement.signed_document_id) {
    return NextResponse.json(
      { error: "This agreement already has a signed document." },
      { status: 400 }
    );
  }

  if (!PRE_EXECUTED_STATUSES.includes(agreement.status)) {
    return NextResponse.json(
      { error: `Cannot stamp an agreement in '${agreement.status}' status` },
      { status: 400 }
    );
  }

  const gateError = await checkVoExecutionPaymentGate(supabase, caseId);
  if (gateError) {
    return NextResponse.json({ error: gateError }, { status: 400 });
  }

  const stampRef = previewedStampRef || generateStampReference();
  const pdfDoc = generateLeaveLicensePdf(
    agreement.variables as unknown as LeaveLicenseVariables,
    { applyCompanyStamp: true, stampRef }
  );
  const stampedBuffer = Buffer.from(pdfDoc.output("arraybuffer"));

  const adminSupabase = await createAdminClient();
  const storagePath = `case-agreements/${caseId}/stamped-sign-seal-${Date.now()}.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, stampedBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "Storage upload failed: " + uploadError.message },
      { status: 500 }
    );
  }

  const { data: docRecord, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: `Leave & License Agreement — Stamped (${stampRef})`,
      file_name: "leave-license-stamped.pdf",
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: stampedBuffer.length,
      category: "case_document",
      uploaded_by: dbUser.id,
    })
    .select("id")
    .single();

  if (docError || !docRecord) {
    return NextResponse.json(
      { error: docError?.message || "Failed to create document record" },
      { status: 500 }
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from("case_agreements")
    .update({
      signed_document_id: docRecord.id,
      status: "executed",
      signed_at: new Date().toISOString(),
      stamp_reference: stampRef,
      pre_stamp_status: agreement.status,
    })
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

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
      action: { old: null, new: "sign_seal_stamp" },
      status: { old: agreement.status, new: "executed" },
      stamp_reference: { old: null, new: stampRef },
      signed_document_id: { old: null, new: docRecord.id },
    },
  });

  return NextResponse.json({ data: { ...updated, stamp_reference: stampRef } });
}
