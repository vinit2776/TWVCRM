import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const folderId = searchParams.get("folder_id");
  const leadId = searchParams.get("lead_id");

  if (leadId) {
    // Get documents linked to a lead
    const { data, error } = await supabase
      .from("lead_documents")
      .select("document:documents!lead_documents_document_id_fkey(*, uploader:users!documents_uploaded_by_fkey(full_name))")
      .eq("lead_id", leadId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data?.map((d) => d.document) || [] });
  }

  let query = supabase
    .from("documents")
    .select("*, uploader:users!documents_uploaded_by_fkey(full_name)")
    .order("created_at", { ascending: false });

  if (folderId) {
    query = query.eq("folder_id", folderId);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also get folders
  const { data: folders } = await supabase
    .from("document_folders")
    .select("*")
    .order("name");

  return NextResponse.json({ data, folders: folders || [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File;
  const title = formData.get("title") as string;
  const folderId = formData.get("folder_id") as string | null;
  const category = formData.get("category") as string | null;
  const leadId = formData.get("lead_id") as string | null;
  const customPath = formData.get("path") as string | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // 10MB limit
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();

  const { data: dbUser } = await adminSupabase
    .from("users").select("id").eq("auth_id", user.id).single();

  // Upload to Supabase Storage (use admin client to bypass storage RLS)
  const fileName = `${Date.now()}-${file.name}`;
  const filePath = customPath ? `${customPath}/${fileName}` : `documents/${fileName}`;

  // Convert File to Buffer for reliable server-side upload (avoids Node.js File API issues)
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, buffer, { contentType: file.type || "application/octet-stream", upsert: false });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Create document record
  const { data: doc, error: docError } = await adminSupabase
    .from("documents")
    .insert({
      title: title || file.name,
      file_name: file.name,
      file_path: filePath,
      mime_type: file.type,
      size_bytes: file.size,
      folder_id: folderId || null,
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

  // Link to lead if provided
  if (leadId && doc) {
    await adminSupabase.from("lead_documents").insert({
      lead_id: leadId,
      document_id: doc.id,
    });
  }

  return NextResponse.json({ data: doc }, { status: 201 });
}
