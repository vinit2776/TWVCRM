import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { handleStatementPaid } from "@/lib/tally-handoff-server";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { canRecordPayments } from "@/lib/constants";

/**
 * POST /api/invoices/[id]/payment
 * Records payment received for an adhoc proforma invoice.
 *
 * Does NOT self-generate a GST invoice — a real GST tax invoice with a valid
 * IRN can only be minted in Tally. Recording payment here routes the linked
 * billing_statements row to `pi_paid_awaiting_gst` via handleStatementPaid(),
 * same as every other invoice in the system, so it lands in the accounts
 * Tally Inbox for a real GST invoice to be issued and sent from there.
 *
 * Body (JSON):
 *   amount      (required) number
 *   reference   (optional) UTR / transaction ID
 *   notes       (optional) string
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // This route had no role check at all — any authenticated user could record
  // money against an ad-hoc invoice, including roles with no finance access.
  // Every other payment route gated on admin/manager/accounts; this one was
  // simply missed. Brought in line with the rest.
  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor || !canRecordPayments(actor.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can record payments" },
      { status: 403 },
    );
  }

  const body = await request.json();
  const amount = parseFloat(body.amount);
  const reference = (body.reference as string | undefined)?.trim() || null;
  const notes = (body.notes as string | undefined)?.trim() || null;

  if (isNaN(amount) || amount <= 0)
    return NextResponse.json({ error: "Valid payment amount is required" }, { status: 400 });

  // Fetch invoice + lead
  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, email, company)")
    .eq("id", id)
    .single();

  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (invoice.status === "paid")
    return NextResponse.json({ error: "Invoice is already marked as paid" }, { status: 400 });

  const paidAt = new Date().toISOString();
  const adminSupabase = createAdminClient();

  // ── Find (or defensively create) the linked billing_statements row ──────────
  // Normally this exists already — created when the invoice was emailed
  // (src/app/api/invoices/[id]/email/route.ts). A draft invoice paid without
  // ever being sent wouldn't have one yet, so create it now.
  let { data: statement } = await adminSupabase
    .from("billing_statements")
    .select("id")
    .eq("invoice_id", id)
    .maybeSingle();

  if (!statement) {
    const todayYmd = new Date().toISOString().slice(0, 10);
    const lineItems = ((invoice.items || []) as Array<{ description: string; quantity: number; unit_price: number; total: number }>).map((item) => ({
      description: item.description,
      qty: item.quantity,
      unit_price: item.unit_price,
      amount: item.total,
      hsn_sac_code: resolveHsnCode("ad_hoc_charges"),
    }));
    const { data: newStatement } = await adminSupabase
      .from("billing_statements")
      .insert({
        invoice_id: id,
        contract_id: null,
        proposal_id: invoice.proposal_id ?? null,
        statement_type: "usage",
        created_via: "adhoc_invoice",
        status: "finalized",
        payment_status: "unpaid",
        handoff_state: "pi_awaiting_payment",
        period_start: todayYmd,
        period_end: todayYmd,
        subtotal: invoice.subtotal,
        fixed_amount: invoice.subtotal,
        tax_percentage: invoice.tax_percentage,
        tax_amount: invoice.tax_amount,
        total_amount: invoice.total_amount,
        due_date: (invoice.due_date as string | null) || todayYmd,
        line_items: [{ type: "usage", label: invoice.title, items: lineItems, subtotal: invoice.subtotal }],
      })
      .select("id")
      .single();
    statement = newStatement;
  }

  // ── Record the payment + route through the shared Tally-handoff pipeline ───
  if (statement) {
    await adminSupabase.from("billing_payments").insert({
      billing_statement_id: statement.id,
      amount,
      payment_date: paidAt.slice(0, 10),
      payment_mode: "other",
      payment_reference: reference,
      recorded_by: actor.id,
    });
    await adminSupabase
      .from("billing_statements")
      .update({ payment_status: "paid" })
      .eq("id", statement.id);
    await handleStatementPaid(adminSupabase, statement.id, "invoice_payment_recorded", actor.id);
  }

  // Update invoice — no more self-generated GST invoice number/fields.
  const { error: updateErr } = await supabase
    .from("proforma_invoices")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_reference: reference,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[invoice payment] update error:", updateErr);
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  }

  // Short, honest acknowledgment — the real GST tax invoice with a valid IRN
  // comes later from accounts via the Tally Inbox, once actually issued in Tally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = invoice.lead as any;
  const customerEmail = lead?.email;
  const customerName = lead
    ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
    : "Customer";

  if (customerEmail) {
    const totalFormatted = `₹${Number(invoice.total_amount).toLocaleString("en-IN")}`;
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject: `Payment received — ${invoice.invoice_number} — The WorkVilla`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Thank you — we've received your payment of <strong>${totalFormatted}</strong> for <strong>${invoice.title}</strong> (${invoice.invoice_number}).</p>
            <p style="color:#333;font-size:14px;">Your GST tax invoice will follow shortly from our accounts team.</p>
            <p style="color:#333;font-size:14px;margin-top:16px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>
      `,
    }).catch(console.error);
  }

  return NextResponse.json({
    message: "Payment recorded — routed to accounts for GST invoice issuance",
    customer_email: customerEmail || null,
    notes,
  });
}
