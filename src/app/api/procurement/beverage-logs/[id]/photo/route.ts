import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

// Photos are a legibility-only verification cross-check, not a reference
// image — keep them smaller than the general asset-photo default (1200/78).
const PHOTO_MAX_DIMENSION = 1000;
const PHOTO_QUALITY = 75;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: log } = await supabase
    .from("beverage_logs")
    .select("id")
    .eq("id", id)
    .single();
  if (!log) return NextResponse.json({ error: "Beverage log not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("photo") as File | null;
  if (!file) return NextResponse.json({ error: "No photo provided" }, { status: 400 });

  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (!normalized.mimeType.startsWith("image/")) {
    return NextResponse.json({ error: "Only image files are allowed" }, { status: 400 });
  }

  const sharp = (await import("sharp")).default;
  const compact = await sharp(normalized.buffer)
    .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();

  const path = `beverage-log-photos/${id}-${Date.now()}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(path, compact, { contentType: "image/jpeg", upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const { data: signed } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(path, 86400 * 365 * 5);

  const { data: updated, error: updateError } = await supabase
    .from("beverage_logs")
    .update({ photo_path: path, photo_url: signed?.signedUrl || path })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ data: updated });
}
