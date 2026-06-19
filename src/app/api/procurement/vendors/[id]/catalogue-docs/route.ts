import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  normalizeUploadServer,
  UploadValidationError,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
} from "@/lib/uploads/normalize-upload-server";
import { logAudit } from "@/lib/audit";

const ALLOWED_CATEGORIES = ["price_list", "catalogue", "quotation", "other"] as const;

// GET /api/procurement/vendors/[id]/catalogue-docs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { searchParams } = new URL(request.url);
  const viewDocId = searchParams.get("viewDocId");

  if (viewDocId) {
    const { data: doc } = await adminSupabase
      .from("vendor_documents")
      .select("file_path")
      .eq("id", viewDocId)
      .eq("vendor_id", id)
      .single();
    if (!doc)
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    const { data: signed, error: signErr } = await adminSupabase.storage
      .from("crm-documents")
      .createSignedUrl(doc.file_path, 3600);
    if (signErr || !signed)
      return NextResponse.json({ error: "Failed to generate URL" }, { status: 500 });
    return NextResponse.json({ data: { signedUrl: signed.signedUrl } });
  }

  const { data: docs, error } = await adminSupabase
    .from("vendor_documents")
    .select("*, uploader:users!vendor_documents_uploaded_by_fkey(full_name)")
    .eq("vendor_id", id)
    .order("created_at", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: docs ?? [] });
}

// POST /api/procurement/vendors/[id]/catalogue-docs
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser)
    return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role))
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 }
    );

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const category = formData.get("category") as string | null;
  const notes = (formData.get("notes") as string | null) || null;

  if (!file)
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (
    !category ||
    !ALLOWED_CATEGORIES.includes(category as (typeof ALLOWED_CATEGORIES)[number])
  )
    return NextResponse.json(
      { error: "Invalid category" },
      { status: 400 }
    );

  if (!IMAGE_MIME_TYPES.has(file.type) && file.type !== PDF_MIME_TYPE) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WEBP, HEIC, and PDF files are accepted" },
      { status: 400 }
    );
  }

  const adminSupabase = await createAdminClient();

  const { data: vendor, error: vendorError } = await adminSupabase
    .from("procurement_vendors")
    .select("id, name")
    .eq("id", id)
    .single();
  if (vendorError || !vendor)
    return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const filePath = `vendors/${id}/catalogue/${category}-${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, {
      contentType: normalized.mimeType,
      upsert: false,
    });

  if (uploadError)
    return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: doc, error: insertError } = await adminSupabase
    .from("vendor_documents")
    .insert({
      vendor_id: id,
      category,
      file_name: file.name,
      file_path: filePath,
      file_size_bytes: normalized.finalBytes,
      file_mime_type: normalized.mimeType,
      notes,
      uploaded_by: dbUser.id,
    })
    .select("id")
    .single();

  if (insertError)
    return NextResponse.json({ error: insertError.message }, { status: 500 });

  logAudit(adminSupabase, {
    action: "create",
    entityType: "document",
    entityId: doc.id,
    performedBy: dbUser.id,
    changes: {
      vendor_id: { old: null, new: id },
      vendor_name: { old: null, new: vendor.name },
      category: { old: null, new: category },
      file_name: { old: null, new: file.name },
    },
  });

  return NextResponse.json({
    data: {
      id: doc.id,
      file_path: filePath,
      original_size_kb: Math.round(normalized.originalBytes / 1024),
      final_size_kb: Math.round(normalized.finalBytes / 1024),
      compressed: normalized.originalBytes !== normalized.finalBytes,
    },
  });
}

// DELETE /api/procurement/vendors/[id]/catalogue-docs?docId=xxx
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser)
    return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager"].includes(dbUser.role))
    return NextResponse.json(
      { error: "Only admin/manager can delete documents" },
      { status: 403 }
    );

  const { searchParams } = new URL(request.url);
  const docId = searchParams.get("docId");
  if (!docId)
    return NextResponse.json({ error: "docId required" }, { status: 400 });

  const adminSupabase = await createAdminClient();

  const { data: doc, error: fetchErr } = await adminSupabase
    .from("vendor_documents")
    .select("id, file_path, file_name, category, vendor_id")
    .eq("id", docId)
    .eq("vendor_id", id)
    .single();

  if (fetchErr || !doc)
    return NextResponse.json({ error: "Document not found" }, { status: 404 });

  await adminSupabase.storage.from("crm-documents").remove([doc.file_path]);

  const { error: deleteErr } = await adminSupabase
    .from("vendor_documents")
    .delete()
    .eq("id", docId);

  if (deleteErr)
    return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  logAudit(adminSupabase, {
    action: "delete",
    entityType: "document",
    entityId: docId,
    performedBy: dbUser.id,
    changes: {
      vendor_id: { old: id, new: null },
      file_name: { old: doc.file_name, new: null },
      category: { old: doc.category, new: null },
    },
  });

  return NextResponse.json({ success: true });
}
