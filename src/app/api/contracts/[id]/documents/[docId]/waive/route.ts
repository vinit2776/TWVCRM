import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string; docId: string }> };

const WAIVE_ROLES = ["admin", "manager"];

/**
 * Waive a KYC document requirement — a permanent decision not to collect it,
 * as opposed to a deferral, which is a dated promise that resumes chasing when
 * it lapses.
 *
 * The distinction matters because deferral was being used for both: ~195 of
 * 242 deferred required documents carry a reason like "Existing Client", and
 * they all duly expired, burying the genuinely overdue items in the weekly
 * digest. A waiver has no date and never reappears there.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !WAIVE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can waive documents" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { reason } = body as { reason?: string };

  // A waiver never expires, so the reason is the only thing a future reader
  // has to judge it by. Never let it be blank.
  if (!reason?.trim()) {
    return NextResponse.json({ error: "A reason is required to waive a document" }, { status: 400 });
  }

  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status === "approved") {
    return NextResponse.json(
      { error: "This document has already been approved — there is nothing to waive." },
      { status: 400 },
    );
  }
  if (doc.status === "waived") {
    return NextResponse.json({ error: "This document is already waived" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("contract_documents")
    .update({
      status: "waived",
      waived_by: dbUser.id,
      waived_at: now,
      waived_reason: reason.trim(),
      // A waiver supersedes any deferral: leaving deferred_until set would
      // keep the row looking overdue in anything that reads that field.
      deferred_by: null,
      deferred_at: null,
      deferred_reason: null,
      deferred_until: null,
      updated_at: now,
    })
    .eq("id", docId)
    .select("*, waiver:users!contract_documents_waived_by_fkey(id, full_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      kyc_document_waived: {
        old: doc.status,
        new: `waived: ${doc.label} — ${reason.trim()}`,
      },
    },
  });

  return NextResponse.json({ data: updated });
}

/** Un-waive: put the requirement back on the books as pending. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !WAIVE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can un-waive documents" }, { status: 403 });
  }

  const { data: doc } = await supabase
    .from("contract_documents")
    .select("id, status, label, waived_reason")
    .eq("id", docId)
    .eq("contract_id", id)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status !== "waived") {
    return NextResponse.json({ error: "Document is not currently waived" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("contract_documents")
    .update({
      status: "pending",
      waived_by: null,
      waived_at: null,
      waived_reason: null,
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
      kyc_document_unwaived: {
        old: `waived: ${doc.waived_reason ?? ""}`,
        new: `pending: ${doc.label}`,
      },
    },
  });

  return NextResponse.json({ data: updated });
}
