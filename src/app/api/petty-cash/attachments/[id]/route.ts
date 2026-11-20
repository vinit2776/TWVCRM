import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canRemoveAttachment } from "@/lib/petty-cash-attachments";

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/petty-cash/attachments/[id]
 * Accounts/admin any time; the uploader while the expense/request is still open.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: att } = await supabase
    .from("petty_cash_attachments")
    .select("id, entry_id, request_id, storage_path, file_name, uploaded_by")
    .eq("id", id).single();
  if (!att) return NextResponse.json({ error: "File not found" }, { status: 404 });

  let locked = false;
  if (att.entry_id) {
    const { data: e } = await supabase.from("petty_cash_entries").select("status").eq("id", att.entry_id).single();
    locked = e?.status === "approved";
  } else if (att.request_id) {
    const { data: r } = await supabase.from("petty_cash_requests").select("status").eq("id", att.request_id).single();
    locked = r?.status === "issued";
  }

  if (!canRemoveAttachment(dbUser.role, dbUser.id, att, locked)) {
    return NextResponse.json({
      error: locked ? "This record is already approved. Ask Accounts to remove the file." : "You can only remove files you added.",
    }, { status: 403 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("petty_cash_attachments").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await admin.storage.from("crm-documents").remove([att.storage_path]);

  logAudit(supabase, {
    entityType: att.entry_id ? "pc_entry" : "pc_request",
    entityId: (att.entry_id ?? att.request_id)!,
    action: "update",
    performedBy: dbUser.id,
    changes: { attachment_removed: { old: att.file_name, new: null } },
  });

  return NextResponse.json({ success: true });
}
