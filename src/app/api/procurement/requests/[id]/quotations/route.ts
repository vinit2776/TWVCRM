import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { IMAGE_MIME_TYPES, PDF_MIME_TYPE } from "@/lib/uploads/normalize-upload-server";

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

// POST — persist a quotation record. Body (JSON): filePath, fileName, mimeType
// (from a prior direct-to-storage upload via /api/documents/upload-url),
// vendor_name, amount, notes?
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

  // File is already uploaded directly to storage by the client via a signed
  // upload URL (see /api/documents/upload-url) — this route only persists
  // the metadata. Proxying the raw file through this route would hit
  // Vercel's 4.5MB serverless request body limit.
  const body = await request.json();
  const filePath = (body.filePath as string | null)?.trim();
  const fileName = (body.fileName as string | null)?.trim();
  const mimeType = (body.mimeType as string | null)?.trim();
  const vendorName = (body.vendor_name as string | null)?.trim();
  const amountRaw = body.amount;
  const notes = (body.notes as string | null)?.trim() || null;

  if (!filePath || !fileName) return NextResponse.json({ error: "File is required" }, { status: 400 });
  if (!vendorName) return NextResponse.json({ error: "Vendor name is required" }, { status: 400 });
  const amount = amountRaw != null ? parseFloat(amountRaw) : NaN;
  if (isNaN(amount) || amount < 0) {
    return NextResponse.json({ error: "A valid quoted amount is required" }, { status: 400 });
  }

  if (!mimeType || (!IMAGE_MIME_TYPES.has(mimeType) && mimeType !== PDF_MIME_TYPE)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WEBP, HEIC, and PDF files are accepted" },
      { status: 400 }
    );
  }

  const adminSupabase = await createAdminClient();

  const { data: inserted, error: insertError } = await adminSupabase
    .from("material_request_quotations")
    .insert({
      pr_id: id,
      vendor_name: vendorName,
      amount,
      file_path: filePath,
      file_name: fileName,
      file_mime_type: mimeType,
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
