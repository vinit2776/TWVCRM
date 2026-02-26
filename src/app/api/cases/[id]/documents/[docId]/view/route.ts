import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET: Generate a signed URL for viewing/downloading a case document
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const { id: caseId, docId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminSupabase = await createAdminClient();

  // Get the case document with linked document record
  const { data: caseDoc, error: docError } = await adminSupabase
    .from("case_documents")
    .select("id, document_id, document:documents(file_path, file_name, mime_type)")
    .eq("id", docId)
    .eq("case_id", caseId)
    .single();

  if (docError || !caseDoc) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docRaw = caseDoc.document as any;
  const doc = Array.isArray(docRaw) ? docRaw[0] : docRaw;

  if (!doc?.file_path) {
    return NextResponse.json(
      { error: "No file uploaded for this document" },
      { status: 404 }
    );
  }

  // Generate a signed URL (valid for 1 hour)
  const { data: signedUrlData, error: signedUrlError } = await adminSupabase.storage
    .from("crm-documents")
    .createSignedUrl(doc.file_path, 3600);

  if (signedUrlError || !signedUrlData?.signedUrl) {
    return NextResponse.json(
      { error: "Failed to generate document URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    url: signedUrlData.signedUrl,
    file_name: doc.file_name,
    mime_type: doc.mime_type,
  });
}
