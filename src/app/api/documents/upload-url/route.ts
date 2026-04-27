import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/documents/upload-url
 *
 * Returns a Supabase signed upload URL so the client can upload files
 * directly to storage, bypassing the Vercel 4.5MB request body limit.
 *
 * Body: { fileName: string, mimeType: string, path?: string }
 * Response: { signedUrl: string, token: string, path: string }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fileName, mimeType, path: customPath } = await request.json();
  if (!fileName) return NextResponse.json({ error: "fileName required" }, { status: 400 });

  const adminSupabase = await createAdminClient();

  const safeName = `${Date.now()}-${fileName}`;
  const filePath = customPath ? `${customPath}/${safeName}` : `documents/${safeName}`;

  const { data, error } = await adminSupabase.storage
    .from("crm-documents")
    .createSignedUploadUrl(filePath);

  if (error || !data) {
    return NextResponse.json({ error: error?.message || "Failed to create upload URL" }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: filePath, mimeType });
}
