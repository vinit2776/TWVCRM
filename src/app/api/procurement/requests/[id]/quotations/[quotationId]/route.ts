import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; quotationId: string }> }
) {
  const { id, quotationId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: pr } = await supabase
    .from("purchase_requests")
    .select("id, status, requested_by")
    .eq("id", id)
    .single();
  if (!pr) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  if (!["draft", "submitted", "rejected"].includes(pr.status)) {
    return NextResponse.json(
      { error: "Quotations can only be removed before approval" },
      { status: 422 }
    );
  }

  const { data: quotation } = await supabase
    .from("material_request_quotations")
    .select("id, pr_id, uploaded_by, file_path, vendor_name")
    .eq("id", quotationId)
    .eq("pr_id", id)
    .single();
  if (!quotation) return NextResponse.json({ error: "Quotation not found" }, { status: 404 });

  // Uploader, requester, admin, manager, or office_admin can delete.
  const canDelete =
    quotation.uploaded_by === dbUser.id ||
    pr.requested_by === dbUser.id ||
    ["admin", "manager", "office_admin"].includes(dbUser.role);
  if (!canDelete) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  const adminSupabase = await createAdminClient();
  const { error: delErr } = await adminSupabase
    .from("material_request_quotations")
    .delete()
    .eq("id", quotationId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  await adminSupabase.storage.from("crm-documents").remove([quotation.file_path]);

  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { quotation_removed: { old: { vendor_name: quotation.vendor_name }, new: null } },
  });

  return NextResponse.json({ ok: true });
}
