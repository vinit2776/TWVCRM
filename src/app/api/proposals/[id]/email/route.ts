import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logEmailActivity } from "@/lib/audit";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { messaging } from "@/lib/whatsapp";

// Allow larger request bodies for PDF attachments (default is 4.5MB)
export const maxDuration = 30; // seconds

/**
 * POST /api/proposals/[id]/email
 *
 * Step 1 of the proposal lifecycle: send the proposal PDF to the lead for
 * review / negotiation.  NO deposit link is included here — that is sent
 * separately as part of the booking-confirmation flow (see /accept route).
 *
 * Accepts either:
 *   multipart/form-data  { pdf: File,        recipients: JSON string, force_send_without_link?: "true" }
 *   application/json     { pdfBase64: string, recipients: string[],   force_send_without_link?: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Support both FormData (binary PDF) and JSON (base64 PDF)
  let recipients: string[];
  let pdfBuffer: Buffer;
  let sendViaWhatsApp = false;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    recipients = JSON.parse(formData.get("recipients") as string || "[]");
    sendViaWhatsApp = formData.get("send_via_whatsapp") === "true";
    const pdfFile = formData.get("pdf") as File;
    if (!pdfFile) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } else {
    const body = await request.json();
    recipients = body.recipients;
    sendViaWhatsApp = body.send_via_whatsapp === true;
    pdfBuffer = Buffer.from(body.pdfBase64, "base64");
  }

  if (!recipients || recipients.length === 0) {
    return NextResponse.json(
      { error: "At least one recipient email is required" },
      { status: 400 }
    );
  }

  if (!pdfBuffer || pdfBuffer.length === 0) {
    return NextResponse.json(
      { error: "PDF data is required" },
      { status: 400 }
    );
  }

  // ── Deposit waiver gate: block send for zero-deposit proposals without OTP approval
  {
    const { data: waiverCheck } = await supabase
      .from("proposals")
      .select("security_deposit_months, deposit_waiver_verified_at")
      .eq("id", id)
      .single();
    if (waiverCheck && Number(waiverCheck.security_deposit_months || 0) === 0 && !waiverCheck.deposit_waiver_verified_at) {
      return NextResponse.json(
        { error: "This proposal has zero security deposit and requires admin OTP approval before it can be sent. Please request and verify the OTP first." },
        { status: 403 }
      );
    }
  }

  // Fetch proposal with lead info
  const { data: proposal, error: fetchError } = await supabase
    .from("proposals")
    .select(
      "*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile)"
    )
    .eq("id", id)
    .single();

  if (fetchError || !proposal) {
    return NextResponse.json(
      { error: "Proposal not found" },
      { status: 404 }
    );
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("id, full_name, email, phone")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";
  const senderEmail = sender?.email || "space@theworkvilla.com";
  const senderPhone = sender?.phone || "+91 97910 97900";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Client";
  const customerPhone = lead?.phone || lead?.mobile;

  // ── Store PDF to Supabase for WhatsApp delivery + tracking redirect ─────────
  // The storage path is saved on the proposal so the public tracking link can
  // serve the PDF directly when the customer clicks "Review Your Proposal".
  let pdfPublicUrl: string | null = null;
  let pdfStoragePath: string | null = null;
  try {
    const adminSupabase = createAdminClient();
    // Use a stable path (overwrite on resend) so the tracking link always serves the latest version
    pdfStoragePath = `proposals/${id}/proposal-latest.pdf`;
    await adminSupabase.storage
      .from("crm-documents")
      .upload(pdfStoragePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    const { data: signedData } = await adminSupabase.storage
      .from("crm-documents")
      .createSignedUrl(pdfStoragePath, 365 * 24 * 3600); // 1 year — sufficient for WA delivery
    pdfPublicUrl = signedData?.signedUrl ?? null;
  } catch (err) {
    // Storage failure is non-blocking; WhatsApp doc send will be skipped
    console.error("[proposal email] PDF storage error:", err);
    pdfStoragePath = null;
  }

  // ── Build tracking URL ──────────────────────────────────────────────────────
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://crm.theworkvilla.com";
  const trackingUrl = `${appBaseUrl}/api/proposals/${id}/track`;

  // ── Build email HTML ────────────────────────────────────────────────────────
  // Step 1 email: clean proposal — no deposit payment button.
  // Customer is being asked to review the proposal and revert with acceptance.
  const depositAmount = Number(proposal.security_deposit_amount || 0);
  const hasDeposit = depositAmount > 0;
  const depositMonths = Number(proposal.security_deposit_months || 0);

  const nextStepsHtml = `
    <p style="color:#015E65;font-size:13px;font-weight:700;margin:24px 0 12px;letter-spacing:0.3px;">NEXT STEPS</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
      <tr>
        <td style="vertical-align:top;padding:0 14px 16px 0;width:32px;">
          <div style="background:#015E65;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">1</div>
        </td>
        <td style="vertical-align:top;padding-bottom:16px;border-bottom:1px solid #e5e7eb;">
          <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Review this Proposal</p>
          <p style="color:#555;font-size:13px;margin:0;">Please go through the attached proposal and let us know if you have any questions or would like to discuss the terms.</p>
        </td>
      </tr>
      ${hasDeposit ? `
      <tr>
        <td style="vertical-align:top;padding:16px 14px 16px 0;width:32px;">
          <div style="background:#00AE6C;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">2</div>
        </td>
        <td style="vertical-align:top;padding:16px 0;border-bottom:1px solid #e5e7eb;">
          <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Confirm your Acceptance</p>
          <p style="color:#555;font-size:13px;margin:0;">Once you are happy with the proposal, simply reply to this email with your acceptance or call us at <strong>+91 97910 97900</strong>. We will then send you a payment link for the refundable security deposit of ₹${depositAmount.toLocaleString("en-IN")} (${depositMonths} month${depositMonths > 1 ? "s" : ""}).</p>
        </td>
      </tr>
      <tr>
        <td style="vertical-align:top;padding:16px 14px 0 0;width:32px;">
          <div style="background:#6B7280;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">3</div>
        </td>
        <td style="vertical-align:top;padding-top:16px;">
          <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Pay Security Deposit &amp; Move In</p>
          <p style="color:#555;font-size:13px;margin:0;">On receipt of the security deposit, we will issue your formal booking confirmation, prepare the workspace agreement, and coordinate your move-in date.</p>
        </td>
      </tr>` : `
      <tr>
        <td style="vertical-align:top;padding:16px 14px 0 0;width:32px;">
          <div style="background:#00AE6C;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">2</div>
        </td>
        <td style="vertical-align:top;padding-top:16px;">
          <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Confirm your Acceptance</p>
          <p style="color:#555;font-size:13px;margin:0;">Once you are happy with the proposal, simply reply to this email or call us at <strong>+91 97910 97900</strong>. We will then finalise your workspace agreement and coordinate your move-in.</p>
        </td>
      </tr>`}
    </table>`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
      </div>
      <div style="padding: 32px;">
        <p style="color: #1a1b1e; font-size: 15px;">Dear ${lead?.first_name || "Client"},</p>
        <p style="color: #333; font-size: 14px;">Thank you for your interest in The WorkVilla. Please find attached our proposal <strong>${proposal.proposal_number}</strong> for <strong>${proposal.title}</strong>.</p>

        <p style="color: #015E65; font-size: 13px; font-weight: 700; margin: 20px 0 8px; letter-spacing: 0.3px;">PROPOSAL SUMMARY</p>
        <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
          <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Proposal</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
          <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Monthly Rental</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${Number(proposal.total_amount).toLocaleString("en-IN")}/month + GST</td></tr>
          ${hasDeposit ? `<tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Security Deposit</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${depositAmount.toLocaleString("en-IN")} (${depositMonths} month${depositMonths > 1 ? "s" : ""}, refundable)</td></tr>` : ""}
          ${proposal.valid_until ? `<tr><td style="padding: 10px 16px; color: #666;">Valid Until</td><td style="padding: 10px 16px; color: #333;">${new Date(proposal.valid_until).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
        </table>

        <!-- Tracking CTA — clicking this marks the proposal as "viewed" server-side -->
        <div style="text-align:center;margin:24px 0;">
          <a href="${trackingUrl}"
             style="display:inline-block;background:#015E65;color:#ffffff;text-decoration:none;
                    font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;
                    letter-spacing:0.3px;">
            Review Your Proposal →
          </a>
          <p style="color:#999;font-size:11px;margin:8px 0 0;">
            Clicking opens the proposal PDF. Your review is automatically noted.
          </p>
        </div>

        ${nextStepsHtml}

        <p style="color: #015E65; font-size: 13px; font-weight: 700; margin: 20px 0 8px; letter-spacing: 0.3px;">BANK TRANSFER DETAILS</p>
        <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 12px;">
          <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
          <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
          <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
          <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.bank}</td></tr>
          <tr><td style="padding: 8px 16px; color: #666;">Branch</td><td style="padding: 8px 16px; color: #333;">${COMPANY_BANK_DETAILS.branch}</td></tr>
        </table>

        <p style="color: #333; font-size: 14px; margin-top: 24px;">We look forward to welcoming you to The WorkVilla. Please don't hesitate to reach out if you have any questions.</p>
        <p style="color: #333; font-size: 14px; margin-top: 16px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
        <p style="color: #666; font-size: 12px; margin-top: 16px;">You can reach me directly at <a href="mailto:${senderEmail}" style="color: #015E65;">${senderEmail}</a> or call <strong>${senderPhone}</strong>.</p>
      </div>
      <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
        <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
      </div>
    </div>
  `;

  try {
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [recipients[0]],
      ...(recipients.length > 1 ? { cc: recipients.slice(1) } : {}),
      subject: `Proposal ${proposal.proposal_number} — ${proposal.title} | The WorkVilla`,
      html,
      attachments: [
        {
          filename: `${proposal.proposal_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    if (emailError) {
      console.error("Resend email error:", emailError);
      return NextResponse.json(
        { error: emailError.message || "Resend failed to send email" },
        { status: 502 }
      );
    }

    console.log("Proposal email sent:", emailResult?.id, "to:", recipients);

    // Update proposal status to "sent" and store the PDF path for tracking redirect
    const sentUpdate: Record<string, unknown> = { status: "sent", sent_at: new Date().toISOString() };
    if (pdfStoragePath) sentUpdate.pdf_storage_path = pdfStoragePath;
    await supabase.from("proposals").update(sentUpdate).eq("id", id);

    // Log email activity
    if (proposal.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: proposal.lead_id,
        subject: `Proposal ${proposal.proposal_number} sent`,
        description: `Proposal "${proposal.title}" (${proposal.proposal_number}) emailed to ${recipients.join(", ")}`,
        createdBy: sender.id,
      });
    }

    // ── WhatsApp document (PDF) — only when explicitly requested ───────────
    if (sendViaWhatsApp && customerPhone && pdfPublicUrl) {
      messaging.proposalDocument(
        customerPhone,
        customerName,
        proposal.proposal_number,
        pdfPublicUrl,
        id
      ).catch((e: unknown) => console.error("[messaging] proposal WA doc failed:", e));
    }

    return NextResponse.json({
      message: "Email sent successfully",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Email send error:", message, error);
    return NextResponse.json(
      { error: `Failed to send email: ${message}` },
      { status: 500 }
    );
  }
}
