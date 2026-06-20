import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

const insertSchema = z.object({
  tier: z.enum(["commercial", "operational"]),
  label: z.string().min(1).max(200),
  file_url: z.string().url(),
  file_name: z.string().optional(),
  file_size: z.number().int().optional(),
  mime_type: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("asset_documents")
    .select(`
      id, asset_id, tier, label, file_url, file_name, file_size, mime_type,
      notes, uploaded_by, created_at, updated_at,
      uploader:users!asset_documents_uploaded_by_fkey(id, full_name)
    `)
    .eq("asset_id", assetId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const allowed = ["admin", "manager", "fms", "accounts", "office_admin", "it_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = insertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("asset_documents")
    .insert({
      asset_id: assetId,
      tier: parsed.data.tier,
      label: parsed.data.label,
      file_url: parsed.data.file_url,
      file_name: parsed.data.file_name || null,
      file_size: parsed.data.file_size || null,
      mime_type: parsed.data.mime_type || null,
      notes: parsed.data.notes || null,
      uploaded_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    action: "create",
    entityType: "asset_document",
    entityId: data.id,
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin/manager can delete documents" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const docId = searchParams.get("doc_id");
  if (!docId) return NextResponse.json({ error: "doc_id required" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("asset_documents")
    .delete()
    .eq("id", docId)
    .eq("asset_id", assetId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    action: "delete",
    entityType: "asset_document",
    entityId: docId,
    performedBy: dbUser.id,
  });

  return NextResponse.json({ success: true });
}
