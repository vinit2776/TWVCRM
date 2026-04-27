import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { messaging } from "@/lib/whatsapp";
import { logEmailActivity, logWhatsAppActivity } from "@/lib/audit";

export const maxDuration = 30;

/**
 * POST /api/proposals/[id]/accept
 *
 * Step 2 of the proposal lifecycle — triggered when the CRM user marks a
 * proposal as "accepted" (mutual agreement reached).
 *
 * Actions:
 *   1. Mark proposal status → "accepted"
 *   2. Create Razorpay deposit payment link (if deposit required and link not yet created)
 *   3. Send booking-confirmation email:
 *        - Proposal PDF attached
 *        - Deposit payment button (Razorpay link)
 *        - Bank transfer details
 *   4. Send WhatsApp text message (deposit payment link)
 *   5. Send WhatsApp document (proposal PDF)
 *   6. Log both activities to lead audit trail
 *
 * Body:  multipart/form-data { pdf: File }
 *        OR application/json  { pdfBase64: string }
 *
 * If the proposal has no security deposit, step 2-4 are skipped and the
 * booking confirmation simply notifies the customer of acceptance.
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
    .from("users").select("id, full_name").eq("auth_id", user.id).single();

  // Parse PDF buffer from request
  let pdfBuffer: Buffer | null = null;
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const pdfFile = formData.get("pdf") as File | null;
      if (pdfFile) pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
    } else {
      const body = await request.json().catch(() => null);
      if (body?.pdfBase64) pdfBuffer = Buffer.from(body.pdfBase64, "base64");
    }
  } catch {
    // PDF is optional — we continue without attachment if missing
  }

  // Fetch proposal with lead
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (!["sent", "viewed"].includes(proposal.status)) {
    return NextResponse.json(
      { error: "Only sent or viewed proposals can be accepted" },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  const depositAmount = Number(proposal.security_deposit_amount || 0);
  const depositMonths = Number(proposal.security_deposit_months || 0);
  const hasDeposit = depositAmount > 0 && proposal.deposit_payment_status === "pending";

  // ── 1. Mark proposal accepted ─────────────────────────────────────────────
  await supabase.from("proposals").update({
    status: "accepted",
    accepted_at: new Date().toISOString(),
  }).eq("id", id);

  // ── 2. Create Razorpay deposit payment link ───────────────────────────────
  let depositLinkUrl: string | null = proposal.deposit_razorpay_link_url || null;
  let depositLinkId: string | null = proposal.deposit_razorpay_link_id || null;

  if (hasDeposit && !depositLinkUrl) {
    try {
      const adminSupabase = createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings").select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

        const expireDate = proposal.valid_until
          ? new Date(proposal.valid_until + "T23:59:59Z")
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: Record<string, any> = {
          amount: Math.round(depositAmount * 100),
          currency: "INR",
          description: `Security Deposit — ${proposal.proposal_number} — The WorkVilla`,
          reference_id: `${proposal.proposal_number}-DEP-${Date.now()}`,
          expire_by: Math.floor(expireDate.getTime() / 1000),
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

        if (rzpRes.ok) {
          const linkData = await rzpRes.json();
          depositLinkUrl = linkData.short_url;
          depositLinkId = linkData.id;
          await supabase.from("proposals").update({
            deposit_razorpay_link_id: depositLinkId,
            deposit_razorpay_link_url: depositLinkUrl,
          }).eq("id", id);
        } else {
          const err = await rzpRes.json().catch(() => null);
          console.error("[accept] Razorpay deposit link creation failed:", err);
        }
      }
    } catch (err) {
      console.error("[accept] Razorpay error:", err);
    }
  }

  // ── 3. Store PDF to Supabase for WhatsApp document delivery ──────────────
  let pdfPublicUrl: string | null = null;
  if (pdfBuffer) {
    try {
      const adminSupabase = createAdminClient();
      const storagePath = `proposals/${id}/booking-confirmation-${Date.now()}.pdf`;
      await adminSupabase.storage
        .from("crm-documents")
        .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

      const { data: signedData } = await adminSupabase.storage
        .from("crm-documents")
        .createSignedUrl(storagePath, 365 * 24 * 3600);
      pdfPublicUrl = signedData?.signedUrl ?? null;
    } catch (err) {
      console.error("[accept] PDF storage error:", err);
    }
  }

  // ── 4. Send booking-confirmation email ────────────────────────────────────
  if (customerEmail) {
    const depositBlock = hasDeposit && depositLinkUrl
      ? `<div style="text-align:center;margin:24px 0;">
           <a href="${depositLinkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Security Deposit — ₹${depositAmount.toLocaleString("en-IN")}</a>
           <p style="color:#666;font-size:11px;margin:8px 0 0;">Refundable deposit (${depositMonths} month${depositMonths > 1 ? "s" : ""}) · Secure payment via Razorpay</p>
         </div>`
      : hasDeposit
        ? `<p style="color:#555;font-size:13px;margin:16px 0;">A payment link for the security deposit of <strong>₹${depositAmount.toLocaleString("en-IN")}</strong> will be sent to you shortly.</p>`
        : "";

    const subject = `Booking Confirmation — ${proposal.proposal_number} — The WorkVilla`;
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#015E65;padding:24px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
          <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Booking Confirmation</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
          <p style="color:#333;font-size:14px;">Great news! We are pleased to confirm that your proposal <strong>${proposal.proposal_number}</strong> — <strong>${proposal.title}</strong> has been mutually accepted.</p>

          <div style="background:#f0faf5;border-left:4px solid #015E65;padding:14px 18px;margin:16px 0;border-radius:0 6px 6px 0;">
            <p style="color:#015E65;font-size:13px;font-weight:600;margin:0 0 6px;">Proposal Summary</p>
            <p style="color:#333;font-size:13px;margin:0 0 4px;">Proposal: <strong>${proposal.proposal_number}</strong></p>
            <p style="color:#333;font-size:13px;margin:0 0 4px;">Monthly Rental: <strong>₹${Number(proposal.total_amount).toLocaleString("en-IN")}/month + GST</strong></p>
            ${hasDeposit ? `<p style="color:#333;font-size:13px;margin:0;">Security Deposit: <strong>₹${depositAmount.toLocaleString("en-IN")}</strong> (${depositMonths} month${depositMonths > 1 ? "s" : ""}, fully refundable)</p>` : ""}
          </div>

          ${hasDeposit ? `
          <p style="color:#015E65;font-size:13px;font-weight:700;margin:24px 0 12px;letter-spacing:0.3px;">TO CONFIRM YOUR BOOKING</p>
          <p style="color:#333;font-size:13px;margin:0 0 12px;">Please pay the refundable security deposit to secure your workspace. This is the <strong>only step required</strong> to confirm your booking.</p>
          ${depositBlock}
          <p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">Pay via Bank Transfer</p>
          <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;margin-bottom:8px;">
            <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Account</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
            <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">A/C No</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
            <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">IFSC</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
            <tr><td style="padding:8px 16px;color:#666;font-weight:600;">Payment Reference</td><td style="padding:8px 16px;color:#015E65;font-weight:700;">${proposal.proposal_number}</td></tr>
          </table>
          <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-bottom:20px;">
            <p style="color:#92400e;font-size:12px;margin:0;">⚠️ <strong>Important:</strong> Please use <strong>${proposal.proposal_number}</strong> as the payment reference when making a bank transfer.</p>
          </div>
          ` : ""}

          <p style="color:#333;font-size:14px;margin-top:20px;">Once the deposit is received, we will send you the workspace agreement and coordinate your move-in. We look forward to welcoming you to The WorkVilla!</p>
          <p style="color:#333;font-size:14px;margin-top:12px;">Warm regards,<br/><strong>${dbUser?.full_name || "The WorkVilla Team"}</strong><br/>The WorkVilla</p>
          <p style="color:#666;font-size:12px;margin-top:12px;">For any queries, write to us at <a href="mailto:space@theworkvilla.com" style="color:#015E65;">space@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
        </div>
        <div style="background:#015E65;padding:12px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
        </div>
      </div>`;

    const emailAttachments = pdfBuffer
      ? [{ filename: `${proposal.proposal_number}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
      : [];

    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject,
      html,
      attachments: emailAttachments,
    }).catch(console.error);

    if (proposal.lead_id && dbUser?.id) {
      logEmailActivity(supabase, {
        leadId: proposal.lead_id,
        subject: `Booking confirmation sent for ${proposal.proposal_number}`,
        description: `Proposal accepted. Booking confirmation emailed to ${customerEmail}${depositLinkUrl ? `. Deposit link: ${depositLinkUrl}` : ""}.`,
        createdBy: dbUser.id,
      });
    }
  }

  // ── 5 & 6. WhatsApp — text (deposit link) + document (PDF) ───────────────
  if (customerPhone) {
    const amountFormatted = depositAmount.toLocaleString("en-IN");

    // Text message with deposit link
    if (hasDeposit && depositLinkUrl) {
      messaging.proposalDepositRequest(
        customerPhone,
        customerName,
        amountFormatted,
        proposal.proposal_number,
        depositLinkUrl,
        id
      ).catch((e: unknown) => console.error("[messaging] booking WA text failed:", e));

      if (proposal.lead_id && dbUser?.id) {
        logWhatsAppActivity(supabase, {
          leadId: proposal.lead_id,
          subject: `Booking confirmation & deposit link sent`,
          description: `Booking confirmed for ${proposal.proposal_number}. Security deposit of ₹${amountFormatted} requested via WhatsApp to ${customerPhone}. Payment link: ${depositLinkUrl}`,
          createdBy: dbUser.id,
        });
      }
    }

    // Document message with proposal PDF
    if (pdfPublicUrl) {
      messaging.bookingConfirmationDocument(
        customerPhone,
        customerName,
        proposal.proposal_number,
        depositAmount > 0 ? amountFormatted : "0",
        depositLinkUrl || "",
        pdfPublicUrl,
        id
      ).catch((e: unknown) => console.error("[messaging] booking WA doc failed:", e));
    }
  }

  return NextResponse.json({
    success: true,
    status: "accepted",
    deposit_link_url: depositLinkUrl,
    deposit_link_id: depositLinkId,
    sent_to: customerEmail,
  });
}
