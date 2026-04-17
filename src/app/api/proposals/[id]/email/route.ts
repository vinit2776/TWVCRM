import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logEmailActivity } from "@/lib/audit";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

// Allow larger request bodies for PDF attachments (default is 4.5MB)
export const maxDuration = 30; // seconds

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

  // Support both FormData (binary PDF) and JSON (base64 PDF) for backwards compat
  let recipients: string[];
  let pdfBuffer: Buffer;
  let forceSendWithoutLink = false;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    recipients = JSON.parse(formData.get("recipients") as string || "[]");
    forceSendWithoutLink = formData.get("force_send_without_link") === "true";
    const pdfFile = formData.get("pdf") as File;
    if (!pdfFile) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } else {
    const body = await request.json();
    recipients = body.recipients;
    forceSendWithoutLink = body.force_send_without_link === true;
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
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Client";
  const customerEmail = lead?.email || recipients[0];
  const customerPhone = lead?.phone || lead?.mobile;

  // ── Create Razorpay deposit payment link (if deposit required and not already created) ──
  // The deposit link is the primary payment sent with the proposal.
  // Monthly charge link is generated separately (manual trigger).
  let depositLinkUrl: string | null = proposal.deposit_razorpay_link_url || null;
  const depositAmount = Number(proposal.security_deposit_amount || 0);
  const hasDeposit = depositAmount > 0 && proposal.deposit_payment_status === "pending";

  // ── Auto-create deposit payment link when sending ──────────────────────────
  // If creation fails and the user hasn't explicitly overridden, we block the
  // send so the customer never receives a proposal without a payment link.
  if (hasDeposit && !proposal.deposit_razorpay_link_id) {
    let rzpError: string | null = null;

    try {
      const adminSupabase = await createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled !== "true" || !rzpMap.razorpay_key_id || !rzpMap.razorpay_key_secret) {
        rzpError = "Razorpay is not enabled in Settings — payment link cannot be created.";
      } else {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

        const expireDate = proposal.valid_until
          ? new Date(proposal.valid_until + "T23:59:59Z")
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const expireBy = Math.floor(expireDate.getTime() / 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: Record<string, any> = {
          amount: Math.round(depositAmount * 100),
          currency: "INR",
          description: `Security Deposit — ${proposal.proposal_number} — The WorkVilla`,
          reference_id: `${proposal.proposal_number}-DEP-${Date.now()}`, // unique suffix prevents duplicate-id conflicts
          expire_by: expireBy,
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
          await supabase
            .from("proposals")
            .update({
              deposit_razorpay_link_id: linkData.id,
              deposit_razorpay_link_url: linkData.short_url,
            })
            .eq("id", id);
        } else {
          const rzpErr = await rzpRes.json().catch(() => null);
          rzpError = rzpErr?.error?.description || rzpErr?.error?.reason || "Razorpay returned an error";
          console.error("[proposal email] Razorpay deposit link creation failed:", rzpErr);
        }
      }
    } catch (err) {
      rzpError = err instanceof Error ? err.message : "Unexpected error contacting Razorpay";
      console.error("[proposal email] Razorpay error:", err);
    }

    // Block the send if link creation failed and user hasn't explicitly overridden
    if (rzpError && !forceSendWithoutLink) {
      return NextResponse.json(
        {
          error: `Security deposit payment link could not be created: ${rzpError}`,
          deposit_link_failed: true,
          razorpay_error: rzpError,
        },
        { status: 422 }
      );
    }
  }

  try {
    const depositMonths = Number(proposal.security_deposit_months || 0);

    // ── Step 1 CTA: Pay security deposit ──────────────────────────────────────
    const step1Button = depositLinkUrl && hasDeposit
      ? `<div style="text-align:center;margin:16px 0 8px;">
           <a href="${depositLinkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Security Deposit — ₹${depositAmount.toLocaleString("en-IN")}</a>
           <p style="color:#666;font-size:11px;margin:8px 0 0;">Refundable deposit (${depositMonths} month${depositMonths > 1 ? "s" : ""}) · Secure payment via Razorpay</p>
         </div>`
      : "";

    // ── Attachments callout ───────────────────────────────────────────────────
    const attachmentsNote = `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin:20px 0;">
        <p style="color:#374151;font-size:13px;font-weight:600;margin:0 0 8px;">📎 Documents attached to this email</p>
        <p style="color:#555;font-size:13px;margin:4px 0;">
          <strong>1. Proposal ${proposal.proposal_number}</strong> — full workspace proposal with pricing and terms.
        </p>
        <p style="color:#555;font-size:13px;margin:4px 0;">
          <strong>2. Pro-forma Invoice (1st month rental)</strong> — ₹${Number(proposal.total_amount).toLocaleString("en-IN")}/month. This can be paid any time before your move-in date.
        </p>
      </div>`;

    // ── How to book section ───────────────────────────────────────────────────
    const howToBook = hasDeposit ? `
      <p style="color:#015E65;font-size:13px;font-weight:700;margin:24px 0 12px;letter-spacing:0.3px;">HOW TO BOOK YOUR SPACE</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
        <tr>
          <td style="vertical-align:top;padding:0 14px 16px 0;width:32px;">
            <div style="background:#015E65;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">1</div>
          </td>
          <td style="vertical-align:top;padding-bottom:16px;border-bottom:1px solid #e5e7eb;">
            <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Pay the Security Deposit — ₹${depositAmount.toLocaleString("en-IN")}</p>
            <p style="color:#555;font-size:13px;margin:0 0 10px;">This is the <strong>first and most important step</strong> to confirm your booking. Once your deposit payment is received, we will send you a formal booking confirmation from The WorkVilla team.</p>
            <p style="color:#777;font-size:12px;margin:0;">Refundable · ${depositMonths} month${depositMonths > 1 ? "s" : ""} · Secure payment via Razorpay or bank transfer</p>
            ${step1Button}
          </td>
        </tr>
        <tr>
          <td style="vertical-align:top;padding:16px 14px 0 0;width:32px;">
            <div style="background:#00AE6C;color:white;border-radius:50%;width:28px;height:28px;text-align:center;line-height:28px;font-size:13px;font-weight:bold;">2</div>
          </td>
          <td style="vertical-align:top;padding-top:16px;">
            <p style="color:#111;font-size:14px;font-weight:600;margin:3px 0 4px;">Pay the First Month Rental — ₹${Number(proposal.total_amount).toLocaleString("en-IN")}</p>
            <p style="color:#555;font-size:13px;margin:0;">The <strong>pro-forma invoice for your first month rental is attached</strong> to this email. This payment can be made at any time before your occupation of the space and does not need to happen before confirmation.</p>
          </td>
        </tr>
      </table>` : "";

    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      subject: `Proposal ${proposal.proposal_number} - ${proposal.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">Thank you for your interest in The WorkVilla. Please find below our proposal <strong>${proposal.proposal_number}</strong> for <strong>${proposal.title}</strong>, along with everything you need to secure your space.</p>

            ${attachmentsNote}

            <p style="color: #015E65; font-size: 13px; font-weight: 700; margin: 20px 0 8px; letter-spacing: 0.3px;">PROPOSAL SUMMARY</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Proposal</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Monthly Rental</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${Number(proposal.total_amount).toLocaleString("en-IN")}/month</td></tr>
              ${hasDeposit ? `<tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Security Deposit</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${depositAmount.toLocaleString("en-IN")} (${depositMonths} month${depositMonths > 1 ? "s" : ""}, refundable)</td></tr>` : ""}
              ${proposal.valid_until ? `<tr><td style="padding: 10px 16px; color: #666;">Valid Until</td><td style="padding: 10px 16px; color: #333;">${new Date(proposal.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
            </table>

            ${howToBook}

            <p style="color: #015E65; font-size: 13px; font-weight: 700; margin: 20px 0 8px; letter-spacing: 0.3px;">BANK TRANSFER DETAILS</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 12px;">
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.bank}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Branch</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.branch}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; font-weight: 600;">Payment Reference</td><td style="padding: 8px 16px; color: #015E65; font-weight: 700; font-size: 15px;">${proposal.proposal_number}</td></tr>
            </table>
            <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-bottom:20px;">
              <p style="color:#92400e;font-size:12px;margin:0;">⚠️ <strong>Important:</strong> Please use <strong>${proposal.proposal_number}</strong> as the payment reference or description when making the bank transfer so we can identify and process your payment promptly.</p>
            </div>
            ${depositLinkUrl ? `<p style="color:#666;font-size:12px;margin-bottom:20px;">Or pay the security deposit online: <a href="${depositLinkUrl}" style="color:#015E65;font-weight:bold;">${depositLinkUrl}</a></p>` : ""}

            <p style="color: #333; font-size: 14px;">We look forward to welcoming you to The WorkVilla. Please don't hesitate to reach out if you have any questions.</p>
            <p style="color: #333; font-size: 14px; margin-top: 16px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
            <p style="color: #666; font-size: 12px; margin-top: 16px;">For any queries, write to us at <a href="mailto:contact@theworkvilla.com" style="color: #015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
          </div>
          <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
            <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
            <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
          </div>
        </div>
      `,
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

    // Update proposal status to "sent" and set sent_at
    await supabase
      .from("proposals")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);

    // Log email activity for the lead
    if (proposal.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: proposal.lead_id,
        subject: `Proposal ${proposal.proposal_number} sent`,
        description: `Proposal "${proposal.title}" (${proposal.proposal_number}) emailed to ${recipients.join(", ")}${depositLinkUrl ? ". Deposit link: " + depositLinkUrl : ""}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({
      message: "Email sent successfully",
      deposit_link_url: depositLinkUrl,
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
