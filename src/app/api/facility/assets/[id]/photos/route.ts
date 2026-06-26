import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

// Photos are compressed to 1200px max on the server — clear on any small screen.
const PHOTO_MAX_DIMENSION = 1200;
const PHOTO_QUALITY = 78;
const MAX_PHOTOS = 6;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  // Fetch current asset to check existing photo count
  const { data: asset } = await supabase
    .from("facility_assets").select("id, asset_code, photos").eq("id", id).single();
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  const existing: { url: string; path: string; size: number }[] = (asset.photos as typeof existing) || [];
  if (existing.length >= MAX_PHOTOS) {
    return NextResponse.json({ error: `Maximum ${MAX_PHOTOS} photos per asset` }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("photo") as File | null;
  if (!file) return NextResponse.json({ error: "No photo provided" }, { status: 400 });

  let normalized;
  try {
    normalized = await normalizeUploadServer(file, {});
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Re-compress to mobile-friendly size using sharp directly
  const sharp = (await import("sharp")).default;
  const mobileBuffer = await sharp(normalized.buffer)
    .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();

  const timestamp = Date.now();
  const path = `asset-photos/${id}/${timestamp}.jpg`;

  const { error: uploadError } = await admin.storage
    .from("crm-documents")
    .upload(path, mobileBuffer, { contentType: "image/jpeg", upsert: false });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // 5-year signed URL — long enough to be effectively permanent for reference photos
  const { data: signed } = await admin.storage
    .from("crm-documents")
    .createSignedUrl(path, 86400 * 365 * 5);

  const newPhoto = { url: signed?.signedUrl || path, path, size: mobileBuffer.byteLength };
  const updated = [...existing, newPhoto];

  const { error: updateError } = await admin
    .from("facility_assets")
    .update({ photos: updated })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ data: newPhoto }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const { path } = await request.json() as { path: string };
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });

  const { data: asset } = await supabase
    .from("facility_assets").select("id, photos").eq("id", id).single();
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  const existing: { url: string; path: string; size: number }[] = (asset.photos as typeof existing) || [];
  const updated = existing.filter((p) => p.path !== path);

  await admin.storage.from("crm-documents").remove([path]);
  await admin.from("facility_assets").update({ photos: updated }).eq("id", id);

  return NextResponse.json({ success: true });
}
