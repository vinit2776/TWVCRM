import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS, RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { messaging } from "@/lib/whatsapp";
import { logAudit, logWhatsAppActivity } from "@/lib/audit";
import { DEPOSIT_DUE_DAYS } from "@/lib/receivables";
import { escapeHtml } from "@/lib/html";
import { logCommunication } from "@/lib/communications-log";

const CUSTOMER_MESSAGE_MAX_LENGTH = 500;
const MAX_CC = 10;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * POST /api/proposals/[id]/deposit-link
 *
 * Modes:
 *   - { preview: true } → returns { html, subject, to, ... } without creating a
 *     Razorpay link or sending any email. Safe to call multiple times.
 *   - { deposit_internal_notes, preview: false | omitted } → creates the
 *     Razorpay link (if not already present) and emails the customer.
 *     deposit_internal_notes is required (≥10 chars) in send mode — an
 *     internal-only note for accounts, never included in the customer email.
 *
 *     Accepts optional `additional_cc: string[]` — copied on the email.
 *   - { deposit_internal_notes, mode: "download" } → same as send (creates or
 *     reuses the link, stamps the sent date / due date, restarts reminders) but
 *     sends no email or WhatsApp. Returns the details the client needs to build
 *     a PDF the team shares with the customer by hand — so the deposit still
 *     ages in AR even when it wasn't emailed from here.
 *
 * All modes accept an optional `deposit_customer_message` — free text shown
 * to the customer inside the email itself (e.g. "this covers the extra seat
 * added on 24 Jun"), distinct from deposit_internal_notes which is never sent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();

  let isPreview = false;
  let internalNotes: string | null = null;
  let customerMessage = "";
  let isDownload = false;
  let additionalCc: string[] = [];
  try {
    const body = await request.json().catch(() => null);
    if (body && body.preview === true) isPreview = true;
    if (body && body.mode === "download") isDownload = true;
    if (body && Array.isArray(body.additional_cc)) {
      additionalCc = Array.from(new Set(
        body.additional_cc
          .filter((e: unknown): e is string => typeof e === "string")
          .map((e: string) => e.trim().toLowerCase())
          .filter(Boolean)
      ));
    }
    if (body && typeof body.deposit_internal_notes === "string") {
      internalNotes = body.deposit_internal_notes.trim();
    }
    if (body && typeof body.deposit_customer_message === "string") {
      customerMessage = body.deposit_customer_message.trim().slice(0, CUSTOMER_MESSAGE_MAX_LENGTH);
    }
  } catch {
    // no body — send mode
  }

  if (!isPreview && (!internalNotes || internalNotes.length < 10)) {
    return NextResponse.json({ error: "Add an internal note (at least 10 characters) so accounts can book this correctly" }, { status: 400 });
  }

  const invalidCc = additionalCc.filter((e) => !EMAIL_RE.test(e));
  if (invalidCc.length > 0) {
    return NextResponse.json({ error: `Invalid CC address: ${invalidCc.join(", ")}` }, { status: 400 });
  }
  if (additionalCc.length > MAX_CC) {
    return NextResponse.json({ error: `At most ${MAX_CC} CC addresses` }, { status: 400 });
  }

  // Fetch proposal with lead
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const ALLOWED_STATUSES = ["sent", "viewed", "accepted"];
  if (!ALLOWED_STATUSES.includes(proposal.status)) {
    return NextResponse.json({ error: "Proposal must be sent to the customer before generating a deposit link" }, { status: 400 });
  }

  if (proposal.deposit_payment_status !== "pending") {
    return NextResponse.json({ error: proposal.deposit_payment_status === "paid" ? "Deposit already paid" : "No deposit required for this proposal" }, { status: 400 });
  }

  const requiredDeposit = Number(proposal.security_deposit_amount || 0);
  const creditApplied = Number(proposal.deposit_credit_amount || 0);
  const exceptionApplied = Number(proposal.deposit_exception_amount || 0);
  const depositAmount = Math.max(0, requiredDeposit + exceptionApplied - creditApplied);
  if (depositAmount <= 0) {
    return NextResponse.json({ error: creditApplied > 0 ? "Deposit credit fully covers the required deposit — nothing to collect" : "Deposit amount is zero" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  // ── Determine Razorpay link ────────────────────────────────────────────────
  // Preview: use existing link if any, else a placeholder.
  // Send: reuse existing link if any; otherwise create a fresh one.
  let depositLinkUrl: string | null = proposal.deposit_razorpay_link_url || null;
  let depositLinkId: string | null = proposal.deposit_razorpay_link_id || null;

  if (!isPreview && !depositLinkUrl) {
    const adminSupabase = createAdminClient();
    const { data: rzpSettings } = await adminSupabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

    const rzpMap: Record<string, string> = {};
    (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

    if (rzpMap.razorpay_enabled !== "true" || !rzpMap.razorpay_key_id || !rzpMap.razorpay_key_secret) {
      return NextResponse.json({ error: "Razorpay is not enabled" }, { status: 400 });
    }

    const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {
      amount: Math.round(depositAmount * 100),
      currency: "INR",
      description: `Security Deposit — ${proposal.proposal_number} — The WorkVilla`,
      reference_id: `${proposal.proposal_number}-DEP-${Date.now()}`,
      expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
      notify: { sms: !!customerPhone, email: !!customerEmail },
      reminder_enable: true,
      notes: { proposal_id: id, proposal_number: proposal.proposal_number, type: "security_deposit" },
      callback_url: `${appUrl}/proposals`,
      callback_method: "get",
    };

    if (customerName || customerEmail || customerPhone) {
      payload.customer = {};
      if (customerName) payload.customer.name = customerName;
      if (customerEmail) payload.customer.email = customerEmail;
      if (customerPhone) payload.customer.contact = customerPhone.replace(/\s/g, "");
    }

    const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!rzpRes.ok) {
      const err = await rzpRes.json().catch(() => null);
      return NextResponse.json({ error: err?.error?.description || "Failed to create payment link" }, { status: 500 });
    }

    const linkData = await rzpRes.json();
    depositLinkUrl = linkData.short_url;
    depositLinkId = linkData.id;

    await supabase
      .from("proposals")
      .update({
        deposit_razorpay_link_id: depositLinkId,
        deposit_razorpay_link_url: depositLinkUrl,
      })
      .eq("id", id);
  }

  // Build HTML — pay button only shown if we actually have a link (always true in send mode;
  // preview mode shows the button if a link already exists, else a "will be generated" note).
  const payButton = depositLinkUrl
    ? `<div style="text-align:center;margin:24px 0;">
         <a href="${depositLinkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Security Deposit</a>
         <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
       </div>`
    : `<div style="text-align:center;margin:24px 0;padding:14px;border:1px dashed #015E65;border-radius:8px;background:#f0faf5;">
         <p style="color:#015E65;font-size:13px;margin:0;font-style:italic;">A secure Razorpay payment link will be generated and inserted here when you click <strong>Send Now</strong>.</p>
       </div>`;

  const customerMessageBlock = customerMessage
    ? `<div style="background:#f0faf5;border-left:3px solid #015E65;border-radius:0 6px 6px 0;padding:10px 14px;margin:0 0 16px;">
         <p style="color:#0f6e56;font-size:13px;margin:0;font-style:italic;">${escapeHtml(customerMessage).replace(/\n/g, "<br/>")}</p>
       </div>`
    : "";

  const subject = `Security Deposit — ${proposal.proposal_number} — The WorkVilla`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Security Deposit Collection</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Thank you for accepting our proposal <strong>${proposal.proposal_number}</strong>. To proceed with the contract, please pay the refundable security deposit of <strong>${proposal.security_deposit_months} month(s)</strong>.</p>
        ${customerMessageBlock}
        <table style="border-collapse:collapse;margin:20px 0;width:100%;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Proposal</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Balance Due</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;font-size:18px;">₹${depositAmount.toLocaleString("en-IN")}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;">Type</td><td style="padding:10px 16px;color:#333;">Refundable (${proposal.security_deposit_months} month${proposal.security_deposit_months > 1 ? "s" : ""})</td></tr>
        </table>
        ${payButton}
        <p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">Bank Transfer</p>
        <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Account</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
          <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">A/C No</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
          <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">IFSC</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
          <tr><td style="padding:8px 16px;color:#666;font-weight:600;">Payment Reference</td><td style="padding:8px 16px;color:#015E65;font-weight:700;">${proposal.proposal_number}</td></tr>
        </table>
        <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-top:12px;">
          <p style="color:#92400e;font-size:12px;margin:0;">⚠️ <strong>Important:</strong> Please use <strong>${proposal.proposal_number}</strong> as the payment reference when making the bank transfer.</p>
        </div>
        <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>`;

  // Preview mode — return HTML without sending
  if (isPreview) {
    return NextResponse.json({
      preview: true,
      subject,
      html,
      to: customerEmail ? [customerEmail] : [],
      deposit_link_url: depositLinkUrl,
      amount: depositAmount,
      link_already_exists: !!proposal.deposit_razorpay_link_url,
    });
  }

  // Send mode — email customer
  if (!isDownload && !customerEmail) {
    return NextResponse.json({ error: "Customer email not found on the lead" }, { status: 400 });
  }

  const emailSentAt = new Date().toISOString();
  // Every request is written to communications_log so the proposal page can
  // show when a deposit was requested, how, from whom and to whom.
  const commLogAdmin = createAdminClient();
  if (!isDownload && customerEmail) {
    let emailError: string | null = null;
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [customerEmail],
        cc: additionalCc.length > 0 ? additionalCc : undefined,
        subject,
        html,
      });
      if (r.error) emailError = r.error.message || "Email provider rejected the send";
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
    }
    if (emailError) console.error("[deposit-link] email failed:", emailError);
    await logCommunication(commLogAdmin, {
      entityType: "proposal",
      entityId: id,
      channel: "email",
      recipient: customerEmail,
      cc: additionalCc,
      subject,
      body: html,
      status: emailError ? "failed" : "sent",
      errorMessage: emailError,
      sentBy: dbUser?.id || null,
    });
  }

  // Stamp the follow-up due date alongside the send timestamp so AR can age
  // the deposit and the reminder ladder has something to gate on. Reset the
  // reminder counters too — re-sending the link restarts the sequence rather
  // than resuming wherever a previous link left off.
  const depositDueDate = new Date(Date.parse(emailSentAt) + DEPOSIT_DUE_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  await supabase
    .from("proposals")
    .update({
      deposit_email_sent_at: emailSentAt,
      deposit_due_date: depositDueDate,
      deposit_reminder_count: 0,
      deposit_last_reminder_sent_at: null,
      deposit_internal_notes: internalNotes,
    })
    .eq("id", id);

  if (isDownload) {
    await logCommunication(commLogAdmin, {
      entityType: "proposal",
      entityId: id,
      channel: "manual",
      recipient: "PDF downloaded to share outside the CRM",
      subject,
      body: html,
      attachmentName: `Security-Deposit-${proposal.proposal_number}.pdf`,
      sentBy: dbUser?.id || null,
    });

    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser?.id || null,
      changes: {
        deposit_request_shared_manually: { old: null, new: emailSentAt },
        deposit_due_date: { old: proposal.deposit_due_date ?? null, new: depositDueDate },
      },
    });

    return NextResponse.json({
      mode: "download",
      deposit_link_url: depositLinkUrl,
      amount: depositAmount,
      proposal_number: proposal.proposal_number,
      security_deposit_months: proposal.security_deposit_months,
      customer_name: customerName,
      company: lead?.company || null,
      customer_message: customerMessage,
      due_date: depositDueDate,
    });
  }

  // WhatsApp — to phone if available. Awaited (not fire-and-forget) so the
  // outcome can be written to the deposit request history.
  //
  // Uses the approved `booking_confirmation_doc` template, whose body already
  // reads "...pay the security deposit of Rs.{{3}} here: {{4}}". The previous
  // `proposal_deposit_request` template was never registered in MSG91, so every
  // one of these sends failed silently.
  //
  // That template carries a document header, so it needs the proposal PDF.
  // pdf_storage_path is only set on proposals sent through the newer flow; when
  // it is missing we skip WhatsApp rather than send a broken template — the
  // email above still carries the Pay button.
  if (customerPhone && depositLinkUrl) {
    const amountFormatted = `${depositAmount.toLocaleString("en-IN")}`;

    if (proposal.pdf_storage_path) {
      const { data: signed } = await commLogAdmin.storage
        .from("crm-documents")
        .createSignedUrl(proposal.pdf_storage_path, 365 * 24 * 3600);

      if (signed?.signedUrl) {
        const waResult = await messaging.bookingConfirmationDocument(
          customerPhone,
          customerName,
          proposal.proposal_number,
          amountFormatted,
          depositLinkUrl,
          signed.signedUrl,
          id
        ).catch((e: unknown) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
        if (!waResult.success) console.error("[messaging] deposit WhatsApp failed:", waResult.error);

        await logCommunication(commLogAdmin, {
          entityType: "proposal",
          entityId: id,
          channel: "whatsapp",
          recipient: customerPhone,
          body: `Security deposit of Rs.${amountFormatted} for ${proposal.proposal_number}. Payment link: ${depositLinkUrl}`,
          attachmentUrl: proposal.pdf_storage_path,
          attachmentName: `${proposal.proposal_number}.pdf`,
          status: waResult.success ? "sent" : "failed",
          errorMessage: waResult.success ? null : waResult.error || "unknown",
          sentBy: dbUser?.id || null,
        });

        // Log in lead activities
        if (proposal.lead_id && dbUser?.id) {
          logWhatsAppActivity(supabase, {
            leadId: proposal.lead_id,
            subject: `Security deposit payment link sent`,
            description: `Security deposit of ₹${amountFormatted} for ${proposal.proposal_number} sent via WhatsApp to ${customerPhone}. Payment link: ${depositLinkUrl}`,
            createdBy: dbUser.id,
          });
        }
      }
    } else {
      console.warn(
        `[deposit-link] No stored PDF for ${proposal.proposal_number} — WhatsApp deposit request skipped (email sent).`
      );
    }
  }

  return NextResponse.json({
    deposit_link_url: depositLinkUrl,
    deposit_link_id: depositLinkId,
    amount: depositAmount,
    sent_to: customerEmail,
    cc: additionalCc,
  });
}
