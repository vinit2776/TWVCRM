import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canAccessTransfer } from "../route";

/**
 * POST /api/procurement/transfers/[id]/attachments
 * Body: { file_url, file_path, file_type?, caption?, issue_id? }
 * Caller is expected to have already uploaded the file to the
 * `stock-transfer-photos` storage bucket and pass the resulting URL + path.
 * Used at receive time to document item state/damage as evidence for
 * any complaints raised afterward.
 */
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

  const { data: transfer } = await supabase
    .from("stock_transfers")
    .select("id, from_location_id, to_location_id")
    .eq("id", id)
    .single();
  if (!transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

  if (!(await canAccessTransfer(supabase, dbUser.id, dbUser.role, transfer.from_location_id, transfer.to_location_id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { file_url, file_path, file_type = "image", caption, issue_id } = body;
  if (!file_url || !file_path) {
    return NextResponse.json({ error: "file_url and file_path are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("stock_transfer_attachments")
    .insert({
      transfer_id: id,
      issue_id: issue_id || null,
      file_url, file_path, file_type,
      caption: caption || null,
      uploaded_by: dbUser.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "stock_transfer",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { attachment_added: { old: null, new: data.id } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

/**
 * DELETE /api/procurement/transfers/[id]/attachments?attachment_id=...
 * Removes the DB row only — storage cleanup happens via a separate
 * cron / lifecycle policy if needed.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can remove attachments" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const attachmentId = searchParams.get("attachment_id");
  if (!attachmentId) return NextResponse.json({ error: "attachment_id is required" }, { status: 400 });

  const { error } = await supabase
    .from("stock_transfer_attachments")
    .delete().eq("id", attachmentId).eq("transfer_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
