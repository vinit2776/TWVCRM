import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET: List all document slots for a case
 * POST: Upload a document to a specific slot (via Supabase Storage)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("case_documents")
    .select("*")
    .eq("case_id", id)
    .order("is_required", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminSupabase = await createAdminClient();

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const documentId = formData.get("document_id") as string;

  if (!file || !documentId) {
    return NextResponse.json(
      { error: "File and document_id are required" },
      { status: 400 }
    );
  }

  // Verify the case document slot exists
  const { data: docSlot, error: slotError } = await adminSupabase
    .from("case_documents")
    .select("id, document_type, case_id")
    .eq("id", documentId)
    .eq("case_id", caseId)
    .single();

  if (slotError || !docSlot) {
    return NextResponse.json(
      { error: "Document slot not found" },
      { status: 404 }
    );
  }

  // Upload file to Supabase Storage
  const fileExt = file.name.split(".").pop() || "pdf";
  const storagePath = `case-documents/${caseId}/${docSlot.document_type}/${Date.now()}.${fileExt}`;

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, fileBuffer, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: "File upload failed: " + uploadError.message },
      { status: 500 }
    );
  }

  // Create a document record
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { data: docRecord, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: file.name,
      file_name: file.name,
      file_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
      category: "case_document",
      uploaded_by: dbUser?.id,
    })
    .select("id")
    .single();

  if (docError) {
    return NextResponse.json(
      { error: "Failed to create document record: " + docError.message },
      { status: 500 }
    );
  }

  // Link the document to the case document slot and update status
  const { data: updatedSlot, error: linkError } = await adminSupabase
    .from("case_documents")
    .update({
      document_id: docRecord?.id,
      status: "uploaded",
    })
    .eq("id", documentId)
    .select("*")
    .single();

  if (linkError) {
    return NextResponse.json(
      { error: "Failed to link document: " + linkError.message },
      { status: 500 }
    );
  }

  // Check if all required documents are now uploaded — auto-transition
  const { data: allDocs } = await adminSupabase
    .from("case_documents")
    .select("is_required, status")
    .eq("case_id", caseId);

  const allRequiredUploaded = (allDocs || [])
    .filter((d) => d.is_required)
    .every((d) => d.status !== "pending");

  if (allRequiredUploaded) {
    // Check if case is in docs_requested status — auto-advance
    const { data: currentCase } = await adminSupabase
      .from("cases")
      .select("status")
      .eq("id", caseId)
      .single();

    if (currentCase?.status === "docs_requested") {
      await adminSupabase
        .from("cases")
        .update({
          status: "docs_received",
          docs_received_at: new Date().toISOString(),
        })
        .eq("id", caseId);
    }
  }

  // Audit log
  if (dbUser?.id) {
    logAudit(adminSupabase, {
      entityType: "case_document",
      entityId: documentId,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: "pending", new: "uploaded" },
        file: { old: null, new: file.name },
      },
    });
  }

  return NextResponse.json({ data: updatedSlot }, { status: 201 });
}
