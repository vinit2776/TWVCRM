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

  const body = await request.json();
  const { recipients, pdfBase64 } = body as {
    recipients: string[];
    pdfBase64: string;
  };

  if (!recipients || recipients.length === 0) {
    return NextResponse.json(
      { error: "At least one recipient email is required" },
      { status: 400 }
    );
  }

  if (!pdfBase64) {
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

  // ── Create Razorpay payment link (if enabled and not already created) ──
  let razorpayLinkUrl: string | null = null;
  let razorpayLinkId: string | null = null;

  if (!proposal.razorpay_payment_link_id) {
    try {
      const adminSupabase = await createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

        // Expire: use valid_until date or 30 days from now
        const expireDate = proposal.valid_until
          ? new Date(proposal.valid_until + "T23:59:59Z")
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const expireBy = Math.floor(expireDate.getTime() / 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: Record<string, any> = {
          amount: Math.round(Number(proposal.total_amount) * 100), // paise
          currency: "INR",
          description: `Proposal ${proposal.proposal_number} — ${proposal.title} — The WorkVilla`,
          reference_id: proposal.proposal_number,
          expire_by: expireBy,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: { proposal_id: id, proposal_number: proposal.proposal_number, lead_id: proposal.lead_id },
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
          razorpayLinkId = linkData.id;
          razorpayLinkUrl = linkData.short_url;

          // Store on proposal
          await supabase
            .from("proposals")
            .update({
              razorpay_payment_link_id: razorpayLinkId,
              razorpay_payment_link_url: razorpayLinkUrl,
            })
            .eq("id", id);
        } else {
          const rzpErr = await rzpRes.json().catch(() => null);
          console.error("[proposal email] Razorpay link creation failed:", rzpErr);
        }
      }
    } catch (err) {
      console.error("[proposal email] Razorpay error:", err);
    }
  } else {
    razorpayLinkUrl = proposal.razorpay_payment_link_url;
    razorpayLinkId = proposal.razorpay_payment_link_id;
  }

  try {
    // Convert base64 to Buffer
    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    // Build payment options HTML
    const payNowButton = razorpayLinkUrl
      ? `<div style="text-align:center;margin:20px 0;">
          <a href="${razorpayLinkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Now — ₹${Number(proposal.total_amount).toLocaleString("en-IN")}</a>
          <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
        </div>`
      : "";

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
            <p style="color: #333; font-size: 14px;">Thank you for your interest in The WorkVilla. Please find attached our proposal <strong>${proposal.proposal_number}</strong> for <strong>${proposal.title}</strong>.</p>
            <p style="color: #333; font-size: 14px;">We have curated this proposal based on your workspace requirements. The details are summarized below:</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Proposal:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Amount:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${Number(proposal.total_amount).toLocaleString("en-IN")}</td></tr>
              ${proposal.valid_until ? `<tr><td style="padding: 10px 16px; color: #666;">Valid Until:</td><td style="padding: 10px 16px; color: #333;">${new Date(proposal.valid_until).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
            </table>

            ${payNowButton}

            <p style="color: #015E65; font-size: 13px; font-weight: bold; margin: 20px 0 8px;">Payment Options</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.bank}</td></tr>
              <tr><td style="padding: 8px 16px; color: #666;">Branch</td><td style="padding: 8px 16px; color: #333;">${COMPANY_BANK_DETAILS.branch}</td></tr>
            </table>
            ${razorpayLinkUrl ? `<p style="color:#666;font-size:12px;">Or pay online: <a href="${razorpayLinkUrl}" style="color:#015E65;font-weight:bold;">${razorpayLinkUrl}</a></p>` : ""}
            <p style="color: #333; font-size: 14px;">Please review the attached proposal at your convenience. We look forward to welcoming you to The WorkVilla.</p>
            <p style="color: #333; font-size: 14px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
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
        description: `Proposal "${proposal.title}" (${proposal.proposal_number}) emailed to ${recipients.join(", ")}${razorpayLinkUrl ? ". Payment link: " + razorpayLinkUrl : ""}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({
      message: "Email sent successfully",
      razorpay_payment_link_url: razorpayLinkUrl,
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
