import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// GET — list all KYC documents for a contract
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_documents")
    .select("*, document:documents!contract_documents_document_id_fkey(id, title, file_name, file_path, mime_type, size_bytes), reviewer:users!contract_documents_reviewed_by_fkey(id, full_name, email)")
    .eq("contract_id", id)
    .order("is_required", { ascending: false })
    .order("created_at");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

// POST — upload a document for a KYC slot
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const documentId = formData.get("document_id") as string | null;

  if (!file || !documentId) {
    return NextResponse.json({ error: "File and document_id are required" }, { status: 400 });
  }

  // Validate document slot exists
  const { data: docSlot } = await supabase
    .from("contract_documents")
    .select("id, document_type, label, status")
    .eq("id", documentId)
    .eq("contract_id", id)
    .single();

  if (!docSlot) return NextResponse.json({ error: "Document slot not found" }, { status: 404 });

  // Upload file to storage
  const ext = file.name.split(".").pop() || "pdf";
  const filePath = `contract-documents/${id}/${docSlot.document_type}/${Date.now()}.${ext}`;
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, buffer, { contentType: file.type, upsert: true });

  if (uploadError) return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });

  // Create document record
  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { data: doc, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: docSlot.label,
      file_name: file.name,
      file_path: filePath,
      mime_type: file.type,
      size_bytes: file.size,
      category: "contract_kyc",
      uploaded_by: dbUser?.id,
    })
    .select("id")
    .single();

  if (docError) return NextResponse.json({ error: docError.message }, { status: 500 });

  // Link document to slot and update status
  const { data: updated, error: linkError } = await adminSupabase
    .from("contract_documents")
    .update({ document_id: doc.id, status: "uploaded", updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .select("*")
    .single();

  if (linkError) return NextResponse.json({ error: linkError.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(adminSupabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { kyc_document_uploaded: { old: null, new: docSlot.label } },
    });
  }

  return NextResponse.json({ data: updated });
}
