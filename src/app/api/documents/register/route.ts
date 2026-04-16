import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/documents/register
 *
 * Creates a document DB record after the file has already been uploaded
 * directly to Supabase Storage via a signed upload URL.
 *
 * Body: { title, fileName, filePath, mimeType, sizeBytes, category, leadId? }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title, fileName, filePath, mimeType, sizeBytes, category, leadId } = await request.json();

  if (!filePath || !fileName) {
    return NextResponse.json({ error: "filePath and fileName are required" }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users").select("id").eq("auth_id", user.id).single();

  const { data: doc, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: title || fileName,
      file_name: fileName,
      file_path: filePath,
      mime_type: mimeType || "application/octet-stream",
      size_bytes: sizeBytes || 0,
      category: category || "general",
      tags: [],
      version: 1,
      uploaded_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (docError) {
    return NextResponse.json({ error: docError.message }, { status: 500 });
  }

  if (leadId && doc) {
    await adminSupabase.from("lead_documents").insert({
      lead_id: leadId,
      document_id: doc.id,
    });
  }

  return NextResponse.json({ data: doc }, { status: 201 });
}
