import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { ACCOUNTING_HEADS, ACCOUNTING_HEAD_LABELS, type AccountingHead } from "@/lib/constants";
import { checkInternalNote } from "@/lib/validate-internal-note";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  // Fetched up front (rather than just before the update) because the internal-note
  // re-check below needs the invoice's current accounting head/title for context.
  const { data: oldInvoice } = await supabase.from("proforma_invoices").select("*").eq("id", id).single();

  if (body.status) allowedFields.status = body.status;
  if (body.paid_at) allowedFields.paid_at = body.paid_at;
  if (body.payment_reference) allowedFields.payment_reference = body.payment_reference;

  // Lets accounts resolve an invoice created with "I don't know" (primary_head
  // null) into a real accounting head, and/or tighten up the internal note.
  if (body.primary_head !== undefined) {
    if (body.primary_head !== null && !ACCOUNTING_HEADS.includes(body.primary_head)) {
      return NextResponse.json({ error: "Invalid accounting head" }, { status: 400 });
    }
    allowedFields.primary_head = body.primary_head;
  }
  if (body.internal_notes !== undefined) {
    if (typeof body.internal_notes !== "string" || body.internal_notes.trim().length < 10) {
      return NextResponse.json({ error: "Internal note must be at least 10 characters" }, { status: 400 });
    }
    const trimmedNote = body.internal_notes.trim();
    // Same AI grading as invoice creation — re-run on every edit so a note can't be
    // tightened down to something vague post-creation with no pushback.
    const effectiveHead = (body.primary_head !== undefined ? body.primary_head : oldInvoice?.primary_head) as
      | AccountingHead
      | null
      | undefined;
    const noteCheck = await checkInternalNote({
      note: trimmedNote,
      accountingHead: effectiveHead ? ACCOUNTING_HEAD_LABELS[effectiveHead] : undefined,
      context: oldInvoice?.title,
    });
    if (noteCheck.status === "rejected") {
      return NextResponse.json({ error: noteCheck.reason }, { status: 400 });
    }
    allowedFields.internal_notes = trimmedNote;
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("proforma_invoices")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldInvoice) {
    logAudit(supabase, {
      entityType: "invoice",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldInvoice as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}
