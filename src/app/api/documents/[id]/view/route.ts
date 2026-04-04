import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/documents/[id]/view
 *
 * Returns a signed URL for viewing a document stored in crm-documents.
 * Uses the service role to generate the signed URL so any authenticated
 * user with access to the document can view it.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  // Fetch document record
  const { data: doc, error } = await adminSupabase
    .from("documents")
    .select("id, file_path, file_name, mime_type")
    .eq("id", id)
    .single();

  if (error || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Generate signed URL (1 hour expiry)
  const { data: signedData, error: signError } = await adminSupabase.storage
    .from("crm-documents")
    .createSignedUrl(doc.file_path, 3600);

  if (signError || !signedData?.signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: signedData.signedUrl });
}
