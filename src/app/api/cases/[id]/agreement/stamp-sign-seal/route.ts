import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generateAgreementPdf, type AgreementTemplateKey, type AgreementVariables } from "@/lib/agreement-generator";
import { generateStampReference } from "@/lib/company-stamp";

const PRE_EXECUTED_STATUSES = [
  "draft",
  "internally_approved",
  "sent_to_client",
  "client_approved",
  "signing",
];

/**
 * POST /api/cases/[id]/agreement/stamp-sign-seal
 *
 * Admin-only manual/offline alternative to Digio: regenerates the VO
 * agreement PDF from its stored template + variables with TWV's signature
 * and seal embedded at generation time (same coordinates as the rest of the
 * signature block), then marks the agreement executed. Does not touch the
 * Digio e-sign flow.
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
  if (!agreementId) {
    return NextResponse.json({ error: "agreement_id is required" }, { status: 400 });
  }

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, signed_document_id, template_key, variables")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "proposal")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "Agreement not found" }, { status: 404 });
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

  const stampRef = generateStampReference();
  const pdfDoc = generateAgreementPdf(
    agreement.template_key as AgreementTemplateKey,
    agreement.variables as unknown as AgreementVariables,
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
      title: `Virtual Office Agreement — Stamped (${stampRef})`,
      file_name: "vo-agreement-stamped.pdf",
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
      .update({ agreement_status: "executed" })
      .eq("id", caseId);
  }

  logAudit(supabase, {
    entityType: "case_agreement",
    entityId: agreementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "sign_seal_stamp" },
      status: { old: agreement.status, new: "executed" },
      signed_document_id: { old: null, new: docRecord.id },
      stamp_reference: { old: null, new: stampRef },
    },
  });

  return NextResponse.json({ data: { ...updated, stamp_reference: stampRef } });
}
