import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { INVOICE_LABELS } from "@/lib/facility/asset-invoice";

const insertSchema = z.object({
  tier: z.enum(["commercial", "operational"]),
  label: z.string().min(1).max(200),
  file_url: z.string().url(),
  file_name: z.string().optional(),
  file_size: z.number().int().optional(),
  mime_type: z.string().optional(),
  notes: z.string().max(1000).optional(),
  // One invoice can cover several assets: the same file gets a row on each of these too.
  also_asset_ids: z.array(z.string().uuid()).max(50).optional(),
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

  const allowed = ["admin", "manager", "fms", "accounts", "office_admin", "coordinator", "it_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = insertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const admin = createAdminClient();
  const isInvoice = INVOICE_LABELS.includes(parsed.data.label);
  const alsoIds = Array.from(new Set((parsed.data.also_asset_ids ?? []).filter((a) => a !== assetId)));
  if (alsoIds.length > 0) {
    if (!isInvoice) {
      return NextResponse.json({ error: "Only an invoice can be attached to more than one asset" }, { status: 422 });
    }
    const { data: found } = await admin.from("facility_assets").select("id").in("id", alsoIds);
    if ((found ?? []).length !== alsoIds.length) {
      return NextResponse.json({ error: "One of the other assets was not found" }, { status: 422 });
    }
  }

  const groupId = isInvoice ? crypto.randomUUID() : null;
  const rows = [assetId, ...alsoIds].map((id) => ({
    asset_id: id,
    tier: parsed.data.tier,
    label: parsed.data.label,
    file_url: parsed.data.file_url,
    file_name: parsed.data.file_name || null,
    file_size: parsed.data.file_size || null,
    mime_type: parsed.data.mime_type || null,
    notes: parsed.data.notes || null,
    uploaded_by: dbUser.id,
    doc_kind: isInvoice ? "invoice" : null,
    invoice_group_id: groupId,
  }));
  const { data: inserted, error } = await admin.from("asset_documents").insert(rows).select();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const data = inserted.find((r) => r.asset_id === assetId) ?? inserted[0];

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
