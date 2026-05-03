import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string; docId: string }> };

// POST — defer a KYC document requirement (admin / manager only)
export async function POST(request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can defer documents" }, { status: 403 });
  }

  const body = await request.json();
  const { reason, defer_until } = body as { reason: string; defer_until?: string };

  if (!reason?.trim()) {
    return NextResponse.json({ error: "Deferral reason is required" }, { status: 400 });
  }

  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status === "approved") {
    return NextResponse.json({ error: "Cannot defer an already-approved document" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("contract_documents")
    .update({
      status: "deferred",
      deferred_by: dbUser.id,
      deferred_at: now,
      deferred_reason: reason.trim(),
      deferred_until: defer_until || null,
      updated_at: now,
    })
    .eq("id", docId)
    .select("*, deferrer:users!contract_documents_deferred_by_fkey(id, full_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_document_deferred: {
        old: doc.status,
        new: `deferred: ${doc.label} — ${reason.trim()}`,
      },
    },
  });

  return NextResponse.json({ data: updated });
}

// PATCH — update an existing deferral (e.g. extend the deadline or
// edit the reason) without losing audit context. Useful from the
// KYC-pending dashboard when admin wants to push a deadline out
// without re-deferring from scratch.
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can edit a deferral" }, { status: 403 });
  }

  const body = await request.json();
  const { reason, defer_until } = body as { reason?: string; defer_until?: string | null };

  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label, deferred_until, deferred_reason")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status !== "deferred") {
    return NextResponse.json({ error: "Document is not currently deferred" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (reason !== undefined) {
    if (!reason?.trim()) return NextResponse.json({ error: "Reason cannot be empty" }, { status: 400 });
    updates.deferred_reason = reason.trim();
  }
  if (defer_until !== undefined) updates.deferred_until = defer_until || null;

  const { data: updated, error } = await supabase
    .from("contract_documents").update(updates).eq("id", docId).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract", entityId: id, action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_deferral_updated: {
        old: `${doc.label}: until=${doc.deferred_until ?? "none"}, reason=${doc.deferred_reason ?? ""}`,
        new: `${doc.label}: until=${updates.deferred_until ?? doc.deferred_until ?? "none"}, reason=${updates.deferred_reason ?? doc.deferred_reason ?? ""}`,
      },
    },
  });

  return NextResponse.json({ data: updated });
}

// DELETE — un-defer: revert deferred document back to pending
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can un-defer documents" }, { status: 403 });
  }

  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status !== "deferred") {
    return NextResponse.json({ error: "Document is not currently deferred" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("contract_documents")
    .update({
      status: "pending",
      deferred_by: null,
      deferred_at: null,
      deferred_reason: null,
      deferred_until: null,
      updated_at: now,
    })
    .eq("id", docId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_document_undeferred: { old: "deferred", new: `pending: ${doc.label}` },
    },
  });

  return NextResponse.json({ data: updated });
}
