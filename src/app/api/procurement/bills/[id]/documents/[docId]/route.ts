import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * PATCH/DELETE /api/procurement/bills/[id]/documents/[docId]
 *
 * Editing or removing an existing document is only allowed while the
 * bill is still pending or rejected. Once a bill is approved, the
 * approval was granted against those exact files, so they're frozen —
 * new documents can still be added via the sibling POST route.
 *
 * This app-level check mirrors the RLS policy on vendor_bill_documents
 * (see migration 00533), so even a direct table write can't bypass it —
 * this route's 403 is a friendlier error, not the only guard.
 */
const patchSchema = z.object({
  file_url: z.string().url(),
  file_name: z.string().trim().min(1).max(255),
});

async function loadBillAndDoc(
  supabase: Awaited<ReturnType<typeof createClient>>,
  billId: string,
  docId: string
) {
  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, created_by, approval_status")
    .eq("id", billId)
    .single();
  if (!bill) return { bill: null, doc: null };

  const { data: doc } = await supabase
    .from("vendor_bill_documents")
    .select("id, file_url, file_name, bill_id")
    .eq("id", docId)
    .eq("bill_id", billId)
    .single();

  return { bill, doc };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { bill, doc } = await loadBillAndDoc(supabase, id, docId);
  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)
    || bill.created_by === dbUser.id;
  if (!canAct) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  if (bill.approval_status === "approved") {
    return NextResponse.json(
      { error: "This bill is approved — documents are locked. Attach a new document instead of editing this one." },
      { status: 403 }
    );
  }

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "file_url and file_name are required" }, { status: 400 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("vendor_bill_documents")
    .update({ file_url: parsed.data.file_url, file_name: parsed.data.file_name })
    .eq("id", docId)
    .select("id, file_url, file_name, doc_type, created_at, uploader:users!vendor_bill_documents_uploaded_by_fkey(id, full_name)")
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ error: updateError?.message || "Failed to update document" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { document: { old: doc.file_name, new: parsed.data.file_name } },
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { bill, doc } = await loadBillAndDoc(supabase, id, docId);
  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)
    || bill.created_by === dbUser.id;
  if (!canAct) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  if (bill.approval_status === "approved") {
    return NextResponse.json(
      { error: "This bill is approved — documents are locked and can't be deleted." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await supabase
    .from("vendor_bill_documents")
    .delete()
    .eq("id", docId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "delete",
    performedBy: dbUser.id,
    changes: { document: { old: doc.file_name, new: null } },
  });

  return NextResponse.json({ data: { id: docId } });
}
