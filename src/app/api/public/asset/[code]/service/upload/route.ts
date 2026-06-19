import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

const MAX_FILES = 5;
const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif",
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const admin = createAdminClient();

  // Look up asset
  const { data: asset } = await admin
    .from("facility_assets")
    .select("id, asset_code")
    .eq("asset_code", code)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  // Must have active AMC
  const { count } = await admin
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("linked_asset_id", asset.id)
    .eq("po_type", "service")
    .in("amc_status", ["active", "expiring"]);

  if (!count || count === 0) {
    return NextResponse.json({ error: "No active AMC for this asset" }, { status: 403 });
  }

  const formData = await request.formData();
  const vendorName = formData.get("vendor_name") as string | null;
  const vendorNotes = formData.get("vendor_notes") as string | null;

  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key === "files" && value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Maximum ${MAX_FILES} files allowed` }, { status: 400 });
  }

  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({
        error: `File type ${file.type} not allowed. Use PDF, JPEG, PNG, or WebP.`,
      }, { status: 400 });
    }
  }

  const uploaded: { id: string; file_name: string; file_url: string }[] = [];

  for (const file of files) {
    let normalized;
    try {
      normalized = await normalizeUploadServer(file);
    } catch (err) {
      if (err instanceof UploadValidationError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    const timestamp = Date.now();
    const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = `amc-service/${asset.asset_code}/${timestamp}-${baseName}.${normalized.ext}`;

    const { error: uploadError } = await admin.storage
      .from("crm-documents")
      .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

    if (uploadError) {
      return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    const { data: signedUrl } = await admin.storage
      .from("crm-documents")
      .createSignedUrl(filePath, 86400 * 365);

    const { data: attachment, error: insertError } = await admin
      .from("amc_event_attachments")
      .insert({
        event_id: null,
        asset_id: asset.id,
        file_url: signedUrl?.signedUrl || filePath,
        file_name: file.name,
        file_size: normalized.buffer.byteLength,
        mime_type: normalized.mimeType,
        uploaded_by_vendor: true,
        vendor_name: vendorName || null,
      })
      .select("id, file_name, file_url")
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    uploaded.push(attachment!);
  }

  // Store vendor notes on the first attachment
  if (vendorNotes?.trim() && uploaded[0]) {
    await admin
      .from("amc_event_attachments")
      .update({ notes: vendorNotes.trim() })
      .eq("id", uploaded[0].id);
  }

  return NextResponse.json({ data: uploaded }, { status: 201 });
}
