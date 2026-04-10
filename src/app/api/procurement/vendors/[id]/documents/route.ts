import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import sharp from "sharp";

const ALLOWED_FIELDS = [
  "pan_doc_path",
  "gst_cert_path",
  "reg_cert_path",
  "aadhar_doc_path",
  "msme_cert_path",
] as const;

type DocField = (typeof ALLOWED_FIELDS)[number];

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_DIMENSION = 2048; // px — longest side
const JPEG_QUALITY = 82;   // good balance of quality vs file size
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB raw input limit

/**
 * Normalise uploaded file:
 * - Images (JPEG / PNG / WEBP) → converted to JPEG, resized to max 2048px on longest side,
 *   compressed to Q82. Typical result: 150–400 KB regardless of input size.
 * - PDFs → passed through unchanged.
 * Returns { buffer, mimeType, ext }.
 */
async function normaliseFile(
  file: File
): Promise<{ buffer: Buffer; mimeType: string; ext: string }> {
  const raw = Buffer.from(await file.arrayBuffer());

  if (IMAGE_MIME_TYPES.has(file.type)) {
    const processed = await sharp(raw)
      .rotate()                            // auto-orient from EXIF
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: processed, mimeType: "image/jpeg", ext: "jpg" };
  }

  // PDF — pass through
  return { buffer: raw, mimeType: "application/pdf", ext: "pdf" };
}

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
  if (!["admin", "manager", "fms", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const field = formData.get("field") as string | null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!field || !ALLOWED_FIELDS.includes(field as DocField)) {
    return NextResponse.json({ error: "Invalid document field" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  // Reject unsupported types early
  if (!IMAGE_MIME_TYPES.has(file.type) && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only JPEG, PNG, WEBP, and PDF files are accepted" }, { status: 400 });
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

  const { buffer, mimeType, ext } = await normaliseFile(file);
  const filePath = `vendors/${id}/${field}-${Date.now()}.${ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });

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

  const originalKB = Math.round(file.size / 1024);
  const finalKB = Math.round(buffer.length / 1024);

  return NextResponse.json({
    data: {
      path: filePath,
      original_size_kb: originalKB,
      final_size_kb: finalKB,
      compressed: originalKB !== finalKB,
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
