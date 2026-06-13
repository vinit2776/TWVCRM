import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { formatCurrency } from "@/lib/utils";
import {
  isHandoffV2Enabled,
  setHandoffState,
} from "@/lib/tally-handoff-server";

/**
 * POST /api/billing-statements/[id]/inbox-send
 *
 * Accounts approves and dispatches a previously-uploaded Tally GST invoice
 * to the customer. Pulls the upload's PDF from Supabase Storage and emails
 * it to the contract's primary contact.
 *
 * Transitions:
 *   - PI flow (payment_status=paid) → handoff_state = 'gst_sent'
 *   - Direct GST (payment_status=unpaid) → handoff_state = 'gst_sent_awaiting_payment'
 *
 * Honors D3 (deliver once): refuses to send if tally_delivered_at is already
 * set; admin can force-resend via the existing admin/tally/redispatch route.
 *
 * Out of scope for this PR (lands in PR #2e or follow-up):
 *   - Razorpay link generation for direct-GST sends. Accounts can create the
 *     link from the existing /billing/[id] page after send; the customer
 *     gets the PDF immediately and can pay via UTR while the link is set up.
 *   - WhatsApp delivery.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!(await isHandoffV2Enabled(supabase))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  // ── Fetch statement + contract + lead + latest upload ───────────────────
  const { data: statementRow } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, handoff_state, tally_delivered_at,
      gst_invoice_number, statement_number,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, billing_mode,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email)
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (!statementRow) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  const statement = statementRow as unknown as {
    id: string;
    total_amount: number;
    payment_status: string;
    handoff_state: string | null;
    tally_delivered_at: string | null;
    gst_invoice_number: string | null;
    statement_number: string | null;
    contract: {
      id: string;
      contract_number: string;
      billing_mode: "proforma_first" | "gst_direct" | null;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
      } | null;
    } | null;
  };

  // D3 (deliver once): refuse to re-dispatch a statement that's already gone out.
  if (statement.tally_delivered_at) {
    return NextResponse.json(
      { error: "Statement already delivered. Use admin/tally/redispatch to resend." },
      { status: 409 },
    );
  }

  if (statement.handoff_state !== "ready_to_send") {
    return NextResponse.json(
      { error: `Statement is in state "${statement.handoff_state}", not ready_to_send. Resolve name check first.` },
      { status: 409 },
    );
  }

  // ── Fetch latest non-superseded upload ──────────────────────────────────
  const { data: upload } = await supabase
    .from("gst_invoice_uploads")
    .select("id, tally_invoice_number, irn, invoice_pdf_url, invoice_amount, invoice_date")
    .eq("billing_statement_id", statement.id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!upload) {
    return NextResponse.json({ error: "No GST invoice upload found" }, { status: 409 });
  }

  // ── Pull the PDF buffer from storage ────────────────────────────────────
  const { data: fileBlob, error: downloadErr } = await supabase
    .storage.from("crm-documents")
    .download(upload.invoice_pdf_url as string);

  if (downloadErr || !fileBlob) {
    return NextResponse.json(
      { error: `Could not retrieve uploaded PDF: ${downloadErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());

  // ── Compose + send email ────────────────────────────────────────────────
  const lead = statement.contract?.lead;
  const recipientEmail = lead?.email;
  if (!recipientEmail) {
    return NextResponse.json(
      { error: "Customer has no email on file. Add an email to the lead, then retry." },
      { status: 422 },
    );
  }

  const partyName = lead?.company
    || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ")
    || "Customer";
  const totalDisplay = formatCurrency(Number(statement.total_amount));
  const isReceipt = statement.payment_status === "paid";
  const invoiceNumber = upload.tally_invoice_number as string;

  const subject = isReceipt
    ? `GST tax invoice ${invoiceNumber} — receipt`
    : `GST tax invoice ${invoiceNumber} — ${totalDisplay} due`;

  const html = isReceipt
    ? `
      <p>Dear ${partyName},</p>
      <p>Thank you for your payment. Please find attached the GST tax invoice
         <strong>${invoiceNumber}</strong> for <strong>${totalDisplay}</strong>,
         as recorded against contract ${statement.contract?.contract_number ?? ""}.</p>
      <p>This invoice is for your records. No further action is required.</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `
    : `
      <p>Dear ${partyName},</p>
      <p>Please find attached the GST tax invoice <strong>${invoiceNumber}</strong>
         for <strong>${totalDisplay}</strong>, against contract
         ${statement.contract?.contract_number ?? ""}.</p>
      <p>Kindly arrange payment at the earliest. If a payment link is needed,
         please reply to this email and we will share one promptly.</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `;

  const filename = `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: recipientEmail,
    replyTo: EMAIL_REPLY_TO,
    subject,
    html,
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  if (result.error) {
    return NextResponse.json(
      { error: `Email delivery failed: ${result.error.message}` },
      { status: 500 },
    );
  }

  // ── Stamp delivery + transition handoff_state ───────────────────────────
  const now = new Date().toISOString();
  await supabase
    .from("billing_statements")
    .update({
      tally_delivered_at: now,
      lifecycle_stage: "sent",
      status: "exported",
    })
    .eq("id", statement.id);

  // PI receipt flow → the customer already paid, the GST invoice is just for
  // their records, accounts has applied the receipt to the new voucher.
  // There's nothing left to do, so close the row immediately.
  // Direct GST flow → still awaiting customer payment + receipt entry.
  const nextState = isReceipt ? "complete" : "gst_sent_awaiting_payment";
  await setHandoffState(supabase, statement.id, nextState, "inbox_save_and_send");

  return NextResponse.json({
    ok: true,
    emailed_to: recipientEmail,
    handoff_state: nextState,
    invoice_number: invoiceNumber,
  });
}
