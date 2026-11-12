import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { ACCOUNTING_HEADS } from "@/lib/constants";
import { mirrorInvoiceToStatement } from "@/lib/adhoc-invoice-mirror";

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

  const { data: oldInvoice } = await supabase.from("proforma_invoices").select("*").eq("id", id).single();

  if (body.status) allowedFields.status = body.status;
  if (body.paid_at) allowedFields.paid_at = body.paid_at;
  if (body.payment_reference) allowedFields.payment_reference = body.payment_reference;
  // Lets accounts manually correct a GST invoice number that never got mirrored
  // from billing_statements (e.g. payment/GST recorded via the accounting side
  // rather than this invoice's own payment route — see the mirrors added to
  // handleStatementPaid and upload-gst-invoice for the forward-going fix).
  if (body.gst_invoice_number !== undefined) {
    if (body.gst_invoice_number !== null && typeof body.gst_invoice_number !== "string") {
      return NextResponse.json({ error: "gst_invoice_number must be a string or null" }, { status: 400 });
    }
    allowedFields.gst_invoice_number = body.gst_invoice_number;
  }
  if (body.gst_invoice_sent_at !== undefined) allowedFields.gst_invoice_sent_at = body.gst_invoice_sent_at;
  if (body.gst_invoice_sent_to !== undefined) allowedFields.gst_invoice_sent_to = body.gst_invoice_sent_to;

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
    allowedFields.internal_notes = body.internal_notes.trim();
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  // "Mark as Sent" — the invoice reached the customer some way other than
  // /api/invoices/[id]/email (downloaded and shared on WhatsApp, say), so
  // there's no email to trigger the billing_statements mirror every other
  // ad-hoc invoice gets. Without it, this invoice would flip to "sent" and
  // then never appear anywhere the AR pipeline looks — no Detail-view row,
  // no "Report paid", nothing to record a payment against.
  //
  // Gated on the OLD status being "draft" until it wasn't enough: an invoice
  // already sitting at "sent" (mirrored via the old, pre-fix Mark as Sent
  // that never created one) or "overdue" (the old Mark as Overdue button,
  // removed but not retroactive) asks for the exact same "sent" body and
  // never got a second chance to mirror. mirrorInvoiceToStatement is
  // idempotent — it looks up an existing statement before creating one — so
  // it's safe to just always attempt it here whenever the caller wants this
  // invoice "sent" and it isn't already a dead end.
  const wantsSent = body.status === "sent";
  const eligibleForMirror =
    wantsSent && !!oldInvoice && oldInvoice.status !== "paid" && oldInvoice.status !== "cancelled";
  if (eligibleForMirror && !oldInvoice.due_date) {
    allowedFields.due_date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  const { data, error } = await supabase
    .from("proforma_invoices")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let billingStatementId: string | null = null;
  if (eligibleForMirror) {
    try {
      const { statementId } = await mirrorInvoiceToStatement(
        createAdminClient(),
        { ...oldInvoice, due_date: (allowedFields.due_date as string | undefined) ?? oldInvoice.due_date },
        { linkId: oldInvoice.razorpay_link_id, linkUrl: oldInvoice.razorpay_link_url },
      );
      billingStatementId = statementId;
    } catch (e) {
      console.error("[invoice PATCH] billing_statements mirror failed (non-fatal):", e);
    }
  }

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

  return NextResponse.json({ data, billing_statement_id: billingStatementId });
}
