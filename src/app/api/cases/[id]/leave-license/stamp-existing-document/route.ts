import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { STAMPED_EXISTING_PREFIX } from "@/lib/company-stamp";

const bodySchema = z.object({
  agreement_id: z.string().min(1),
  pdfBase64: z.string().min(1),
  stampRef: z.string().min(1),
});

/**
 * POST /api/cases/[id]/leave-license/stamp-existing-document
 *
 * Admin-only: applies TWV's signature and seal on top of the signed copy that
 * was already uploaded for the Leave & License agreement (for example a
 * customer-signed scan). stamp-sign-seal can't do this: it builds a fresh PDF
 * from the case data and is refused once a signed document exists, which left
 * an uploaded copy with no way to carry the company stamp.
 *
 * Same approach as the contract route of the same name: the browser overlays
 * the stamp on the existing PDF (pdf-lib) and posts the result here to store.
 * The uploaded copy is kept as the previous version, and the agreement stays
 * executed.
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "agreement_id, pdfBase64 and stampRef are required" }, { status: 400 });
  }
  const { agreement_id: agreementId, pdfBase64, stampRef } = parsed.data;

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, status, signed_document_id, generated_document_id, stamp_reference, leegality_status")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  // manual-sign keeps the uploaded copy in generated_document_id, so that is
  // where an executed, never-stamped agreement's signed copy usually lives.
  const currentDocId = agreement.signed_document_id ?? agreement.generated_document_id;

  if (agreement.status !== "executed" || !currentDocId) {
    return NextResponse.json(
      { error: "This agreement has no uploaded signed document to stamp." },
      { status: 400 }
    );
  }

  // Drawing on an e-signed PDF would invalidate its digital signatures.
  if (agreement.leegality_status === "COMPLETED") {
    return NextResponse.json(
      { error: "This agreement was e-signed, so the company stamp can't be added on top of it." },
      { status: 400 }
    );
  }

  if (agreement.stamp_reference) {
    return NextResponse.json(
      { error: "This document already carries a company stamp. Cancel it first to re-stamp." },
      { status: 400 }
    );
  }

  const stampedBuffer = Buffer.from(pdfBase64, "base64");
  if (stampedBuffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: "The stamped file is not a PDF." }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();

  const { data: originalDoc, error: originalDocError } = await adminSupabase
    .from("documents")
    .select("id, version")
    .eq("id", currentDocId)
    .single();

  if (originalDocError || !originalDoc) {
    return NextResponse.json(
      { error: "Could not find the currently attached signed document." },
      { status: 500 }
    );
  }

  const storagePath = `case-agreements/${caseId}/${STAMPED_EXISTING_PREFIX}${Date.now()}.pdf`;

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
      title: `Leave & License Agreement — Signed copy, stamped (${stampRef})`,
      file_name: "leave-license-signed-stamped.pdf",
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: stampedBuffer.length,
      category: "case_document",
      version: (originalDoc.version || 1) + 1,
      parent_document_id: originalDoc.id,
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
    .update({ signed_document_id: docRecord.id, stamp_reference: stampRef })
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "case_agreement",
    entityId: agreementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "sign_seal_stamp_existing_document" },
      signed_document_id: { old: originalDoc.id, new: docRecord.id },
      stamp_reference: { old: null, new: stampRef },
    },
  });

  return NextResponse.json({ data: { ...updated, stamp_reference: stampRef } });
}
