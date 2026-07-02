import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
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
  request: NextRequest,
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

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  // ── Fetch statement + contract + lead + latest upload ───────────────────
  const { data: statementRow } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, handoff_state, tally_delivered_at,
      gst_invoice_number, statement_number, razorpay_payment_link_url,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, billing_mode,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, billing_emails, mobile, phone)
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
    razorpay_payment_link_url: string | null;
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
        billing_emails: string[] | null;
        mobile: string | null;
        phone: string | null;
      } | null;
    } | null;
  };

  // D3 (deliver once): refuse to re-dispatch a statement that's already gone out.
  if (statement.tally_delivered_at) {
    // Auto-heal: if the email was sent but the state transition failed (step 3
    // succeeded, step 4 threw), the row is stuck in ready_to_send with
    // tally_delivered_at already set. Fix the state so the UI switches to
    // showing "Resend email" instead of "Retry send" after refresh.
    if (statement.handoff_state === "ready_to_send") {
      const healedState = statement.payment_status === "paid" ? "complete" : "gst_sent_awaiting_payment";
      await adminClient
        .from("billing_statements")
        .update({ lifecycle_stage: "sent", status: "exported" })
        .eq("id", statement.id);
      await setHandoffState(adminClient, statement.id, healedState, "inbox_send_heal");
    }
    return NextResponse.json(
      { error: "Statement already delivered. Refresh the page and use the 'Resend email' button." },
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

  // ── Resolve recipient list ───────────────────────────────────────────────
  // Parse optional one-time extra recipients from request body.
  let extraRecipients: string[] = [];
  try {
    const body = await request.json().catch(() => ({})) as { extra_recipients?: string[] };
    if (Array.isArray(body.extra_recipients)) extraRecipients = body.extra_recipients;
  } catch { /* body may be empty */ }

  // ── Compose + send email ────────────────────────────────────────────────
  const lead = statement.contract?.lead;
  const recipientEmail = lead?.email;
  if (!recipientEmail) {
    return NextResponse.json(
      { error: "Customer has no email on file. Add an email to the lead, then retry." },
      { status: 422 },
    );
  }

  // Combine primary + billing list + one-time extras, deduped
  const allRecipients = Array.from(new Set([
    recipientEmail,
    ...(lead?.billing_emails ?? []),
    ...extraRecipients,
  ].filter(Boolean)));

  const partyName = lead?.company
    || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ")
    || "Customer";
  const totalDisplay = formatCurrency(Number(statement.total_amount));
  const isReceipt = statement.payment_status === "paid";
  const invoiceNumber = upload.tally_invoice_number as string;
  const contractNumber = statement.contract?.contract_number ?? "";
  const totalAmount = Number(statement.total_amount);
  const customerPhone = lead?.mobile || lead?.phone || "";

  // ── Create Razorpay payment link (only for unpaid direct-GST sends) ──────
  let rzpLinkId: string | null = null;
  let rzpLinkUrl: string | null = null;
  if (!isReceipt && !statement.razorpay_payment_link_url) {
    const { data: settingsRows } = await adminClient
      .from("app_settings").select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
    const settings = (settingsRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => {
      m[r.key] = r.value; return m;
    }, {});
    const rzpEnabled = settings.razorpay_enabled === "true" && !!settings.razorpay_key_id && !!settings.razorpay_key_secret;
    if (rzpEnabled) {
      const rzpAuth = Buffer.from(`${settings.razorpay_key_id}:${settings.razorpay_key_secret}`).toString("base64");
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const refId = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`;
        const payload: Record<string, unknown> = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `Tax Invoice ${invoiceNumber} — ${contractNumber} — The WorkVilla`,
          reference_id: refId,
          expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          notify: { sms: !!customerPhone, email: !!recipientEmail },
          reminder_enable: true,
          notes: { statement_id: id, contract_number: contractNumber, gst_invoice: invoiceNumber },
          callback_url: `${appUrl}/billing`,
          callback_method: "get",
        };
        if (partyName || recipientEmail || customerPhone) {
          payload.customer = {
            ...(partyName ? { name: partyName } : {}),
            ...(recipientEmail ? { email: recipientEmail } : {}),
            ...(customerPhone ? { contact: customerPhone.replace(/\s/g, "") } : {}),
          };
        }
        const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${rzpAuth}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (rzpRes.ok) {
          const linkData = await rzpRes.json() as { id: string; short_url: string };
          rzpLinkId = linkData.id;
          rzpLinkUrl = linkData.short_url;
          await adminClient.from("billing_statements").update({
            razorpay_payment_link_id: rzpLinkId,
            razorpay_payment_link_url: rzpLinkUrl,
          }).eq("id", id);
        } else {
          console.error("[inbox-send] Razorpay link failed:", await rzpRes.text());
        }
      } catch (err) {
        console.error("[inbox-send] Razorpay link threw:", err);
      }
    }
  } else if (statement.razorpay_payment_link_url) {
    rzpLinkUrl = statement.razorpay_payment_link_url;
  }

  const subject = isReceipt
    ? `GST tax invoice ${invoiceNumber} — receipt`
    : `GST tax invoice ${invoiceNumber} — ${totalDisplay} due`;

  const html = isReceipt
    ? `
      <p>Dear ${partyName},</p>
      <p>Thank you for your payment. Please find attached the GST tax invoice
         <strong>${invoiceNumber}</strong> for <strong>${totalDisplay}</strong>,
         as recorded against contract ${contractNumber}.</p>
      <p>This invoice is for your records. No further action is required.</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `
    : `
      <p>Dear ${partyName},</p>
      <p>Please find attached the GST tax invoice <strong>${invoiceNumber}</strong>
         for <strong>${totalDisplay}</strong>, against contract ${contractNumber}.</p>
      ${rzpLinkUrl ? `<p>Pay online: <a href="${rzpLinkUrl}">${rzpLinkUrl}</a></p>` : "<p>Kindly arrange payment at the earliest.</p>"}
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `;

  const filename = `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: allRecipients,
    bcc: [EMAIL_REPLY_TO],
    replyTo: EMAIL_REPLY_TO,
    subject,
    html,
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  if (result.error) {
    await supabase.from("audit_trail").insert({
      entity_type: "billing_statement",
      entity_id: id,
      action: "email_failed",
      performed_by: null,
      changes: { error: result.error.message, recipient: recipientEmail, trigger: "inbox_send" },
    });
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
    emailed_to: allRecipients.join(","),
    handoff_state: nextState,
    invoice_number: invoiceNumber,
  });
}
