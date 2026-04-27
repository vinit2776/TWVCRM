import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  normalizeUploadServer,
  UploadValidationError,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
} from "@/lib/uploads/normalize-upload-server";

const ALLOWED_FIELDS = [
  "pan_doc_path",
  "gst_cert_path",
  "reg_cert_path",
  "aadhar_doc_path",
  "msme_cert_path",
] as const;

type DocField = (typeof ALLOWED_FIELDS)[number];

// POST /api/procurement/vendors/[id]/documents
// Upload a compliance document, normalise it, and store the path on the vendor record.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const field = formData.get("field") as string | null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!field || !ALLOWED_FIELDS.includes(field as DocField)) {
    return NextResponse.json({ error: "Invalid document field" }, { status: 400 });
  }

  // Reject unsupported types up front with a friendly message (the normalizer
  // would throw too, but this message is clearer for this specific route).
  if (!IMAGE_MIME_TYPES.has(file.type) && file.type !== PDF_MIME_TYPE) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WEBP, HEIC, and PDF files are accepted" },
      { status: 400 }
    );
  }

  const adminSupabase = await createAdminClient();

  const { data: vendor, error: vendorError } = await adminSupabase
    .from("procurement_vendors")
    .select("id")
    .eq("id", id)
    .single();
  if (vendorError || !vendor) {
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
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

  const filePath = `vendors/${id}/${field}-${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType, upsert: true });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { error: updateError } = await adminSupabase
    .from("procurement_vendors")
    .update({ [field]: filePath, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      path: filePath,
      original_size_kb: Math.round(normalized.originalBytes / 1024),
      final_size_kb: Math.round(normalized.finalBytes / 1024),
      compressed: normalized.originalBytes !== normalized.finalBytes,
    },
  });
}

// GET /api/procurement/vendors/[id]/documents?field=pan_doc_path
// Generate a signed URL for a compliance document.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const field = searchParams.get("field") as DocField | null;

  if (!field || !ALLOWED_FIELDS.includes(field)) {
    return NextResponse.json({ error: "Invalid document field" }, { status: 400 });
  }

  const { data: vendor } = await supabase
    .from("procurement_vendors")
    .select(field)
    .eq("id", id)
    .single();

  const path = (vendor as Record<string, unknown> | null)?.[field] as string | null;
  if (!path) return NextResponse.json({ error: "No document uploaded" }, { status: 404 });

  const adminSupabase = await createAdminClient();
  const { data: signed, error } = await adminSupabase.storage
    .from("crm-documents")
    .createSignedUrl(path, 3600);

  if (error || !signed) {
    return NextResponse.json({ error: "Failed to generate URL" }, { status: 500 });
  }

  return NextResponse.json({ data: { signedUrl: signed.signedUrl } });
}
