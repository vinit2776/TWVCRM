import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string; docId: string }> };

// POST — approve or reject a KYC document
export async function POST(request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin and managers can review documents" }, { status: 403 });
  }

  const body = await request.json();
  const { status, rejection_reason, notes } = body as { status: string; rejection_reason?: string; notes?: string };

  if (!["approved", "rejected"].includes(status)) {
    return NextResponse.json({ error: "Status must be 'approved' or 'rejected'" }, { status: 400 });
  }

  // Fetch current doc
  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status === "pending") {
    return NextResponse.json({ error: "Document must be uploaded before review" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status,
    reviewed_by: dbUser.id,
    reviewed_at: now,
    updated_at: now,
  };
  if (status === "rejected") updates.rejection_reason = rejection_reason || null;
  if (notes) updates.notes = notes;

  const { data: updated, error } = await supabase
    .from("contract_documents")
    .update(updates)
    .eq("id", docId)
    .select("*, reviewer:users!contract_documents_reviewed_by_fkey(id, full_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { kyc_document_review: { old: doc.status, new: `${status}: ${doc.label}` } },
  });

  return NextResponse.json({ data: updated });
}
