import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const REUPLOAD_ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];

const metaSchema = z.object({
  reason: z.enum(["name_change", "law_change", "other"]),
  reason_notes: z.string().trim().max(2000).optional(),
  is_signed_sealed: z.enum(["true", "false"]),
});

/**
 * POST /api/cases/[id]/leave-license/reupload-agreement
 *
 * Adds a new version of the executed L&L agreement — e.g. a customer legal
 * name change or a change-of-law redocumentation — without losing the
 * document it replaces, and without touching status/signed_at (that's
 * manual-sign's job on first execution; this only swaps the file).
 *
 * pdf/route.ts treats signed_document_id as the document of record once set,
 * falling back to generated_document_id otherwise (manual-sign writes the
 * countersigned copy there) — this route follows the same field, so
 * whichever one is currently displayed is the one that gets versioned.
 *
 * is_signed_sealed is informational only — never blocks the upload.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!REUPLOAD_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to reupload agreements" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const agreementId = formData.get("agreement_id") as string | null;
  const parsed = metaSchema.safeParse({
    reason: formData.get("reason"),
    reason_notes: formData.get("reason_notes") || undefined,
    is_signed_sealed: formData.get("is_signed_sealed"),
  });

  if (!file || !agreementId) {
    return NextResponse.json({ error: "file and agreement_id are required" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File must be under 20 MB" }, { status: 400 });
  }

  const { reason, reason_notes: reasonNotes, is_signed_sealed: isSignedSealedStr } = parsed.data;
  const isSignedSealed = isSignedSealedStr === "true";

  const { data: agreement } = await supabase
    .from("case_agreements")
    .select("id, agreement_number, signed_document_id, generated_document_id")
    .eq("id", agreementId)
    .eq("case_id", caseId)
    .eq("type", "leave_license")
    .single();

  if (!agreement) {
    return NextResponse.json({ error: "L&L Agreement not found" }, { status: 404 });
  }

  const currentField = agreement.signed_document_id ? "signed_document_id" : "generated_document_id";
  const currentDocId = agreement.signed_document_id ?? agreement.generated_document_id;

  if (!currentDocId) {
    return NextResponse.json({
      error: "This agreement has no existing document to version. Generate or upload one first.",
    }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();

  const { data: currentDoc, error: currentDocError } = await adminSupabase
    .from("documents")
    .select("id, version")
    .eq("id", currentDocId)
    .single();

  if (currentDocError || !currentDoc) {
    return NextResponse.json({ error: "Could not find the currently attached agreement document." }, { status: 500 });
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `case-agreements/${caseId}/reupload-leave-license-${Date.now()}.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, fileBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: "Storage upload failed: " + uploadError.message }, { status: 500 });
  }

  const { data: docRecord, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: `Leave & License Agreement ${agreement.agreement_number || ""} (Reuploaded)`.trim(),
      file_name: file.name || "reuploaded-leave-license.pdf",
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: fileBuffer.length,
      category: "case_document",
      version: (currentDoc.version || 1) + 1,
      parent_document_id: currentDoc.id,
      reupload_reason: reason,
      reupload_notes: reasonNotes || null,
      is_signed_sealed: isSignedSealed,
      uploaded_by: dbUser.id,
    })
    .select("id")
    .single();

  if (docError || !docRecord) {
    return NextResponse.json({ error: docError?.message || "Failed to create document record" }, { status: 500 });
  }

  const { data: updated, error: updateErr } = await supabase
    .from("case_agreements")
    .update({ [currentField]: docRecord.id })
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
    action: "agreement_document_reuploaded",
    performedBy: dbUser.id,
    changes: {
      [currentField]: { old: currentDoc.id, new: docRecord.id },
      reason: { old: null, new: reason },
      is_signed_sealed: { old: null, new: isSignedSealed },
    },
  });

  return NextResponse.json({ data: updated });
}
