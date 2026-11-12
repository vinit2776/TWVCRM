import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const REUPLOAD_ALLOWED_ROLES = ["admin", "manager", "sales_rep"];

const metaSchema = z.object({
  reason: z.enum(["name_change", "law_change", "other"]),
  reason_notes: z.string().trim().max(2000).optional(),
  is_signed_sealed: z.enum(["true", "false"]),
});

/**
 * POST /api/contracts/[id]/reupload-agreement
 *
 * Adds a new version of the executed agreement — e.g. a customer legal name
 * change or a change-of-law redocumentation — without losing the document it
 * replaces. Chains onto documents.parent_document_id/version, the same
 * version mechanism stamp-existing-document/route.ts already uses, so the
 * old executed copy stays downloadable via GET agreement-versions.
 *
 * is_signed_sealed is informational only: an uploader can still submit a
 * copy they haven't confirmed is fully signed & sealed. It never blocks the
 * upload or gates contract activation/renewal/billing — it only drives a
 * warning badge in the UI.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!REUPLOAD_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({
      error: "You do not have permission to reupload agreements. Please ask your manager or admin.",
    }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const parsed = metaSchema.safeParse({
    reason: formData.get("reason"),
    reason_notes: formData.get("reason_notes") || undefined,
    is_signed_sealed: formData.get("is_signed_sealed"),
  });

  if (!file) {
    return NextResponse.json({ error: "A file is required" }, { status: 400 });
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

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, signed_document_id")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (!contract.signed_document_id) {
    return NextResponse.json({
      error: "This contract has no existing signed agreement to version. Upload the first signed document via e-Signing or company stamp first.",
    }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();

  const { data: currentDoc, error: currentDocError } = await adminSupabase
    .from("documents")
    .select("id, version")
    .eq("id", contract.signed_document_id)
    .single();

  if (currentDocError || !currentDoc) {
    return NextResponse.json({ error: "Could not find the currently attached signed document." }, { status: 500 });
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `signed-contracts/${contractId}/reupload-${Date.now()}.pdf`;

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
      title: `Signed Contract - ${contract.contract_number} (Reuploaded)`,
      file_name: file.name || "reuploaded-agreement.pdf",
      file_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: fileBuffer.length,
      category: "signed_contract",
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
    .from("contracts")
    .update({ signed_document_id: docRecord.id })
    .eq("id", contractId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: contractId,
    action: "agreement_document_reuploaded",
    performedBy: dbUser.id,
    changes: {
      signed_document_id: { old: currentDoc.id, new: docRecord.id },
      reason: { old: null, new: reason },
      is_signed_sealed: { old: null, new: isSignedSealed },
    },
  });

  return NextResponse.json({ data: updated });
}
