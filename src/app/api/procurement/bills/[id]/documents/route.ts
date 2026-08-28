import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

/**
 * POST /api/procurement/bills/[id]/documents
 *
 * Attaches a document to a bill. Allowed in ANY approval state — a bill
 * approved last week can still get a debit note or corrected paperwork
 * added on top. Editing/deleting an existing document is a separate,
 * more restricted route (see [docId]/route.ts) that locks once approved.
 *
 * Roles: same as who can already act on the bill (see canAct in the
 * parent [id]/route.ts) — the creator, or admin/manager/office_admin/accounts.
 */
const bodySchema = z.object({
  file_url: z.string().url(),
  file_name: z.string().trim().min(1).max(255),
});

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

  const { data: bill, error: fetchError } = await supabase
    .from("vendor_bills")
    .select("id, created_by")
    .eq("id", id)
    .single();
  if (fetchError || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const canAct = ["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)
    || bill.created_by === dbUser.id;
  if (!canAct) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  const body = await request.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "file_url and file_name are required" }, { status: 400 });
  }

  const { data: doc, error: insertError } = await supabase
    .from("vendor_bill_documents")
    .insert({
      bill_id: id,
      file_url: parsed.data.file_url,
      file_name: parsed.data.file_name,
      doc_type: "supporting",
      uploaded_by: dbUser.id,
    })
    .select("id, file_url, file_name, doc_type, created_at, uploader:users!vendor_bill_documents_uploaded_by_fkey(id, full_name)")
    .single();

  if (insertError || !doc) {
    return NextResponse.json({ error: insertError?.message || "Failed to attach document" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "create",
    performedBy: dbUser.id,
    changes: { document: { old: null, new: parsed.data.file_name } },
  });

  return NextResponse.json({ data: doc });
}
