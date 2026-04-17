import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logEmailActivity } from "@/lib/audit";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let recipients: string[];
  let pdfBuffer: Buffer;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    recipients = JSON.parse(formData.get("recipients") as string || "[]");
    const pdfFile = formData.get("pdf") as File;
    if (!pdfFile) return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } else {
    const body = await request.json();
    recipients = body.recipients;
    pdfBuffer = Buffer.from(body.pdfBase64, "base64");
  }

  if (!recipients || recipients.length === 0)
    return NextResponse.json({ error: "At least one recipient email is required" }, { status: 400 });
  if (!pdfBuffer || pdfBuffer.length === 0)
    return NextResponse.json({ error: "PDF data is required" }, { status: 400 });

  // Fetch invoice + lead
  const { data: invoice, error: fetchError } = await supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (fetchError || !invoice)
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const { data: sender } = await supabase
    .from("users").select("id, full_name").eq("auth_id", user.id).single();
  const senderName = sender?.full_name || "TWV Team";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = invoice.lead as any;
  const customerEmail = lead?.email || recipients[0];
  const customerPhone = lead?.phone || lead?.mobile;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";

  // ── Auto-create Razorpay payment link ────────────────────────────────────────
  let paymentLinkUrl: string | null = invoice.razorpay_link_url || null;

  if (!invoice.razorpay_link_id && Number(invoice.total_amount) > 0) {
    try {
      const adminSupabase = createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

        const expireBy = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: Record<string, any> = {
          amount: Math.round(Number(invoice.total_amount) * 100),
          currency: "INR",
          description: `${invoice.invoice_number} — ${invoice.title} — The WorkVilla`,
          reference_id: `${invoice.invoice_number}-${Date.now()}`,
          expire_by: expireBy,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: { invoice_id: id, invoice_number: invoice.invoice_number, type: "adhoc_invoice" },
          callback_url: `${appUrl}/invoices`,
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
          paymentLinkUrl = linkData.short_url;
          await supabase
            .from("proforma_invoices")
            .update({ razorpay_link_id: linkData.id, razorpay_link_url: linkData.short_url })
            .eq("id", id);
        } else {
          console.warn("[invoice email] Razorpay link creation failed:", await rzpRes.json().catch(() => null));
        }
      }
    } catch (e) {
      console.warn("[invoice email] Razorpay error (non-fatal):", e);
    }
  }

  // ── Build email ───────────────────────────────────────────────────────────────
  const totalFormatted = `₹${Number(invoice.total_amount).toLocaleString("en-IN")}`;

  const payButton = paymentLinkUrl
    ? `<div style="text-align:center;margin:24px 0 8px;">
         <a href="${paymentLinkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay ${totalFormatted} Online</a>
         <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
       </div>`
    : "";

  try {
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      subject: `Invoice ${invoice.invoice_number} — ${invoice.title} — The WorkVilla`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:bold;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${lead?.first_name || "Client"},</p>
            <p style="color:#333;font-size:14px;">Please find attached the invoice <strong>${invoice.invoice_number}</strong> for <strong>${invoice.title}</strong>.</p>

            <p style="color:#015E65;font-size:13px;font-weight:700;margin:20px 0 8px;letter-spacing:0.3px;">INVOICE SUMMARY</p>
            <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;margin-bottom:20px;">
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Invoice</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${invoice.invoice_number}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Description</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${invoice.title}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Amount Due</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;font-size:18px;border-bottom:1px solid #e5e7eb;">${totalFormatted}</td></tr>
              ${invoice.due_date ? `<tr><td style="padding:10px 16px;color:#666;">Due Date</td><td style="padding:10px 16px;color:#333;">${new Date(invoice.due_date).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
            </table>

            ${payButton}

            <p style="color:#015E65;font-size:13px;font-weight:700;margin:24px 0 8px;letter-spacing:0.3px;">BANK TRANSFER DETAILS</p>
            <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;margin-bottom:12px;">
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Account Name</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account Number</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">IFSC Code</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Bank</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.bank}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Branch</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.branch}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;font-weight:600;">Payment Reference</td><td style="padding:8px 16px;color:#015E65;font-weight:700;font-size:15px;">${invoice.invoice_number}</td></tr>
            </table>
            <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin-bottom:20px;">
              <p style="color:#92400e;font-size:12px;margin:0;">⚠️ <strong>Important:</strong> Please use <strong>${invoice.invoice_number}</strong> as the payment reference when making a bank transfer so we can identify your payment promptly.</p>
            </div>
            ${paymentLinkUrl ? `<p style="color:#666;font-size:12px;margin-bottom:20px;">Or pay online: <a href="${paymentLinkUrl}" style="color:#015E65;font-weight:bold;">${paymentLinkUrl}</a></p>` : ""}

            <p style="color:#333;font-size:14px;">Once we confirm receipt of payment, a GST tax invoice will be issued to you.</p>
            <p style="color:#333;font-size:14px;margin-top:16px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
            <p style="color:#666;font-size:12px;margin-top:16px;">For queries, email <a href="mailto:contact@theworkvilla.com" style="color:#015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
          </div>
          <div style="background:#015E65;padding:16px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">GST: 33AAACU4245J1ZF</p>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `${invoice.invoice_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    if (emailError) {
      console.error("Resend email error:", emailError);
      return NextResponse.json({ error: emailError.message || "Resend failed" }, { status: 502 });
    }

    console.log("Invoice email sent:", emailResult?.id, "to:", recipients);

    // Update status to "sent"
    await supabase
      .from("proforma_invoices")
      .update({ status: "sent" })
      .eq("id", id);

    if (invoice.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: invoice.lead_id,
        subject: `Invoice ${invoice.invoice_number} sent`,
        description: `Proforma Invoice "${invoice.title}" (${invoice.invoice_number}) emailed to ${recipients.join(", ")}${paymentLinkUrl ? " with Razorpay payment link" : ""}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({
      message: "Email sent successfully",
      payment_link_url: paymentLinkUrl,
    });
  } catch (error) {
    console.error("Email send error:", error);
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
