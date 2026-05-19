import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { z } from "zod";

const VALID_DOC_TYPES = ["pan_card", "gstin_certificate", "aadhaar", "cancelled_cheque", "other"] as const;

type KycDocument = {
  name: string;
  doc_type: string;
  path: string;
  uploaded_at: string;
};

// POST — upload a KYC document and append to landlord.kyc_documents
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const doc_type = (formData.get("doc_type") as string) || "other";

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!VALID_DOC_TYPES.includes(doc_type as never))
    return NextResponse.json({ error: "Invalid doc_type" }, { status: 400 });

  // Normalize (images → JPEG, PDF pass-through, 50 MB cap)
  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }

  const timestamp = Date.now();
  const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const filePath = `landlord-kyc/${id}/${timestamp}-${baseName}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError)
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });

  // Fetch current kyc_documents array
  const { data: landlord, error: fetchErr } = await supabase
    .from("landlords")
    .select("kyc_documents")
    .eq("id", id)
    .single();

  if (fetchErr || !landlord)
    return NextResponse.json({ error: "Landlord not found" }, { status: 404 });

  const existing: KycDocument[] = Array.isArray(landlord.kyc_documents) ? landlord.kyc_documents : [];
  const newDoc: KycDocument = {
    name: file.name,
    doc_type,
    path: filePath,
    uploaded_at: new Date().toISOString(),
  };

  const { data: updated, error: updateErr } = await supabase
    .from("landlords")
    .update({ kyc_documents: [...existing, newDoc] })
    .eq("id", id)
    .select("id, kyc_documents")
    .single();

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "landlord",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { kyc_document_uploaded: { old: null, new: filePath } },
  });

  // Return with signed URL for the just-uploaded doc
  const { data: signed } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(filePath, 3600);

  return NextResponse.json({
    data: updated,
    signed_url: signed?.signedUrl ?? null,
  });
}

// DELETE — remove a specific KYC document by storage path
const deleteSchema = z.object({ path: z.string().min(1) });

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "path is required" }, { status: 400 });

  const { path } = parsed.data;

  const { data: landlord, error: fetchErr } = await supabase
    .from("landlords")
    .select("kyc_documents")
    .eq("id", id)
    .single();

  if (fetchErr || !landlord)
    return NextResponse.json({ error: "Landlord not found" }, { status: 404 });

  const existing: KycDocument[] = Array.isArray(landlord.kyc_documents) ? landlord.kyc_documents : [];
  const filtered = existing.filter((d) => d.path !== path);

  if (filtered.length === existing.length)
    return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Remove from storage
  await supabase.storage.from("crm-documents").remove([path]);

  const { error: updateErr } = await supabase
    .from("landlords")
    .update({ kyc_documents: filtered })
    .eq("id", id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "landlord",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { kyc_document_deleted: { old: path, new: null } },
  });

  return NextResponse.json({ success: true });
}

// GET — return kyc_documents with fresh signed URLs
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: landlord, error } = await supabase
    .from("landlords")
    .select("kyc_documents")
    .eq("id", id)
    .single();

  if (error || !landlord) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const docs: KycDocument[] = Array.isArray(landlord.kyc_documents) ? landlord.kyc_documents : [];

  const withUrls = await Promise.all(
    docs.map(async (doc) => {
      const { data: signed } = await supabase.storage
        .from("crm-documents")
        .createSignedUrl(doc.path, 3600);
      return { ...doc, signed_url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ data: withUrls });
}
