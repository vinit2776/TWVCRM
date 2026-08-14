import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { formatCurrency } from "@/lib/utils";
import { logCommunication } from "@/lib/communications-log";

/**
 * POST /api/billing-statements/[id]/resend-gst-invoice
 *
 * Resends the uploaded Tally GST invoice PDF to the customer.
 * Available to accounts + admin + sales_rep. Does not gate on tally_delivered_at —
 * explicit resend is intentional. Logs every attempt (success or failure)
 * to audit_trail.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const additionalCc: string[] = Array.isArray(body.cc) ? (body.cc as string[]).filter(Boolean) : [];
  const toOverride: string[] = Array.isArray(body.to) ? (body.to as string[]).filter(Boolean) : [];
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!["accounts", "admin", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  const { data: statementRow } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, statement_number, period_start,
      contract:contracts!billing_statements_contract_id_fkey(
        contract_number,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, billing_emails)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        proposal_number,
        lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, billing_emails)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company, email, billing_emails)
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
    statement_number: string | null;
    period_start: string | null;
    contract: {
      contract_number: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null; email: string | null; billing_emails: string[] | null } | null;
    } | null;
    proposal: {
      proposal_number: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null; email: string | null; billing_emails: string[] | null } | null;
    } | null;
    invoice: {
      invoice_number: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null; email: string | null; billing_emails: string[] | null } | null;
    } | null;
  };

  const lead = statement.contract?.lead ?? statement.proposal?.lead ?? statement.invoice?.lead;
  const recipientEmail = lead?.email;
  if (!recipientEmail) {
    return NextResponse.json(
      { error: "Customer has no email on file." },
      { status: 422 },
    );
  }

  const toList = toOverride.length > 0
    ? Array.from(new Set(toOverride.filter(Boolean)))
    : Array.from(new Set([recipientEmail, ...(lead?.billing_emails ?? [])].filter(Boolean)));

  const { data: upload } = await supabase
    .from("gst_invoice_uploads")
    .select("id, tally_invoice_number, invoice_pdf_url, invoice_date, invoice_amount")
    .eq("billing_statement_id", id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!upload) {
    return NextResponse.json({ error: "No GST invoice upload found for this statement." }, { status: 409 });
  }

  const { data: fileBlob, error: downloadErr } = await supabase.storage
    .from("crm-documents")
    .download(upload.invoice_pdf_url as string);

  if (downloadErr || !fileBlob) {
    return NextResponse.json(
      { error: `Could not retrieve PDF: ${downloadErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
  const invoiceNumber = upload.tally_invoice_number as string;
  const contractNumber = statement.contract?.contract_number ?? statement.proposal?.proposal_number ?? statement.invoice?.invoice_number ?? "";
  const partyName = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Customer";
  const isReceipt = statement.payment_status === "paid";
  const totalDisplay = formatCurrency(Number(statement.total_amount));
  const filename = `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;

  const subject = isReceipt
    ? `GST tax invoice ${invoiceNumber} — receipt`
    : `GST tax invoice ${invoiceNumber} — ${totalDisplay} due`;

  const html = isReceipt
    ? `<p>Dear ${partyName},</p>
       <p>Please find attached your GST tax invoice <strong>${invoiceNumber}</strong> for <strong>${totalDisplay}</strong> against contract ${contractNumber}.</p>
       <p>This invoice is for your records. No further action is required.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`
    : `<p>Dear ${partyName},</p>
       <p>Please find attached your GST tax invoice <strong>${invoiceNumber}</strong> for <strong>${totalDisplay}</strong> against contract ${contractNumber}.</p>
       <p>Kindly arrange payment at the earliest. If a payment link is needed, please reply to this email and we will share one promptly.</p>
       <p>Regards,<br/>The WorkVilla — Accounts</p>`;

  const nowIso = new Date().toISOString();
  const sendResult = await resend.emails.send({
    from: EMAIL_FROM,
    to: toList,
    cc: additionalCc.length > 0 ? additionalCc : undefined,
    bcc: [EMAIL_REPLY_TO],
    replyTo: EMAIL_REPLY_TO,
    subject,
    html,
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  await adminClient.from("billing_send_log").insert(
    toList.map((recipient) => ({
      billing_statement_id: id,
      send_type: "gst_invoice" as const,
      recipient,
      status: sendResult.error ? ("failed" as const) : ("sent" as const),
      error: sendResult.error ? sendResult.error.message : null,
      triggered_by: "manual" as const,
      triggered_by_user_id: dbUser.id,
    })),
  );

  // Same content-preview log every other send path writes to — without this,
  // a resend triggered from the Tally Inbox never shows up in "Recent
  // communications" even though the email genuinely went out.
  await logCommunication(adminClient, {
    entityType: "billing_statement",
    entityId: id,
    channel: "email",
    recipient: toList.join(", "),
    subject,
    body: html,
    attachmentUrl: upload.invoice_pdf_url as string,
    attachmentName: filename,
    status: sendResult.error ? "failed" : "sent",
    errorMessage: sendResult.error?.message ?? null,
    sentBy: dbUser.id,
  });

  if (sendResult.error) {
    await adminClient.from("audit_trail").insert({
      entity_type: "billing_statement",
      entity_id: id,
      action: "email_failed",
      performed_by: null,
      changes: { error: sendResult.error.message, recipient: toList.join(", "), trigger: "resend_gst_invoice" },
    });
    return NextResponse.json(
      { error: `Email delivery failed: ${sendResult.error.message}` },
      { status: 500 },
    );
  }

  // Record the full recipient list, not just the primary — otherwise a later
  // audit (or the reconcile backfill) can't tell CC'd contacts already got it
  // and re-sends a duplicate.
  await adminClient.from("billing_statements")
    .update({ gst_invoice_sent_at: nowIso, gst_invoice_sent_to: toList.join(", ") })
    .eq("id", id);

  // Also stamp the same delivery-bookkeeping fields dispatchTallyInvoice /
  // upload-gst-invoice use so a manual resend counts as "delivered" for the
  // payment-reminder cron's gate too — but only if nothing has claimed
  // delivery yet, so a later resend doesn't reset the original delivered_at.
  await adminClient.from("billing_statements")
    .update({ tally_delivered_at: nowIso, lifecycle_stage: "sent", emailed_at: nowIso, emailed_to: recipientEmail })
    .eq("id", id)
    .is("tally_delivered_at", null);

  await adminClient.from("audit_trail").insert({
    entity_type: "billing_statement",
    entity_id: id,
    action: "email_resent",
    performed_by: null,
    changes: { recipient: toList.join(", "), cc: additionalCc.length > 0 ? additionalCc : undefined, invoice_number: invoiceNumber, trigger: "resend_gst_invoice" },
  });

  return NextResponse.json({ ok: true, emailed_to: toList.join(", ") });
}
