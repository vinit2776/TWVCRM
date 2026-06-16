import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  normalizeUploadServer,
  UploadValidationError,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
} from "@/lib/uploads/normalize-upload-server";

// GET — list quotations for an MR with signed URLs for each file.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("material_request_quotations")
    .select("*, uploader:users!material_request_quotations_uploaded_by_fkey(id, full_name, email)")
    .eq("pr_id", id)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const adminSupabase = await createAdminClient();
  const withUrls = await Promise.all(
    (data ?? []).map(async (q) => {
      const { data: signed } = await adminSupabase.storage
        .from("crm-documents")
        .createSignedUrl(q.file_path, 3600);
      return { ...q, signed_url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ data: withUrls });
}

// POST — upload a new quotation. multipart/form-data: file, vendor_name, amount, notes?
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // Confirm the MR exists, and block uploads once approved/closed.
  const { data: pr, error: prErr } = await supabase
    .from("purchase_requests")
    .select("id, status")
    .eq("id", id)
    .single();
  if (prErr || !pr) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (!["draft", "submitted", "rejected"].includes(pr.status)) {
    return NextResponse.json(
      { error: "Quotations can only be added before approval" },
      { status: 422 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const vendorName = (formData.get("vendor_name") as string | null)?.trim();
  const amountRaw = formData.get("amount") as string | null;
  const notes = (formData.get("notes") as string | null)?.trim() || null;

  if (!file) return NextResponse.json({ error: "File is required" }, { status: 400 });
  if (!vendorName) return NextResponse.json({ error: "Vendor name is required" }, { status: 400 });
  const amount = amountRaw != null ? parseFloat(amountRaw) : NaN;
  if (isNaN(amount) || amount < 0) {
    return NextResponse.json({ error: "A valid quoted amount is required" }, { status: 400 });
  }

  if (!IMAGE_MIME_TYPES.has(file.type) && file.type !== PDF_MIME_TYPE) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WEBP, HEIC, and PDF files are accepted" },
      { status: 400 }
    );
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

  const adminSupabase = await createAdminClient();
  const filePath = `material-requests/${id}/quotation-${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, {
      contentType: normalized.mimeType,
      upsert: false,
    });
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: inserted, error: insertError } = await adminSupabase
    .from("material_request_quotations")
    .insert({
      pr_id: id,
      vendor_name: vendorName,
      amount,
      file_path: filePath,
      file_name: file.name,
      file_mime_type: normalized.mimeType,
      notes,
      uploaded_by: dbUser.id,
    })
    .select("*")
    .single();

  if (insertError) {
    // Best-effort cleanup if DB insert fails after upload succeeded.
    await adminSupabase.storage.from("crm-documents").remove([filePath]);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { quotation_added: { old: null, new: { vendor_name: vendorName, amount } } },
  });

  return NextResponse.json({ data: inserted }, { status: 201 });
}
