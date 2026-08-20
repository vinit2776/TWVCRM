import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit, logEmailActivity } from "@/lib/audit";
import { messaging } from "@/lib/whatsapp";

// POST — Email GST invoice PDF to selected recipients
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params; // contract_payment ID
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await request.json();
  const { recipients, send_via_whatsapp } = body as { recipients: string[]; send_via_whatsapp?: boolean };

  if (!recipients || recipients.length === 0) {
    return NextResponse.json({ error: "At least one recipient email is required" }, { status: 400 });
  }

  // Fetch payment with contract and lead info
  const { data: payment, error: fetchError } = await supabase
    .from("contract_payments")
    .select(
      "*, contract:contracts!contract_payments_contract_id_fkey(id, contract_number, title, lead_id, total_amount, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, phone, mobile))"
    )
    .eq("id", id)
    .single();

  if (fetchError || !payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentData = payment as any;

  if (!paymentData.gst_invoice_path) {
    return NextResponse.json({ error: "No GST invoice uploaded for this payment" }, { status: 400 });
  }

  // Download the file from storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("crm-documents")
    .download(paymentData.gst_invoice_path);

  if (downloadError || !fileData) {
    return NextResponse.json({ error: "Failed to download invoice file" }, { status: 500 });
  }

  const fileBuffer = Buffer.from(await fileData.arrayBuffer());
  const fileName = paymentData.gst_invoice_number
    ? `${paymentData.gst_invoice_number}.pdf`
    : paymentData.gst_invoice_path.split("/").pop() || "gst-invoice.pdf";

  // Determine content type from file extension
  const ext = paymentData.gst_invoice_path.split(".").pop()?.toLowerCase();
  const contentType = ext === "pdf" ? "application/pdf" : `image/${ext || "png"}`;

  const senderName = dbUser.full_name || "TWV Team";
  const lead = paymentData.contract?.lead;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Client";

  try {
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      subject: `GST Invoice ${paymentData.gst_invoice_number || ""} — ${paymentData.contract?.contract_number || "Contract"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">Please find attached the GST invoice for your membership at The WorkVilla. Below is a summary:</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Invoice Number:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${paymentData.gst_invoice_number || "—"}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Contract:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${paymentData.contract?.contract_number || ""}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Company:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${customerName}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666;">Amount:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65;">₹${Number(paymentData.amount).toLocaleString("en-IN")}</td></tr>
            </table>
            <p style="color: #333; font-size: 14px;">Please retain this invoice for your tax records. If you have any questions regarding this invoice, feel free to reach out to us.</p>
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
          filename: fileName,
          content: fileBuffer,
          contentType,
        },
      ],
    });

    // Resend SDK returns { data, error } — does NOT throw on failure
    if (emailError) {
      console.error("Resend email error:", emailError);
      return NextResponse.json(
        { error: emailError.message || "Resend failed to send GST invoice email" },
        { status: 502 }
      );
    }

    console.log("GST invoice email sent:", emailResult?.id, "to:", recipients);

    // Update payment: mark as sent
    await supabase
      .from("contract_payments")
      .update({
        gst_invoice_status: "sent",
        gst_invoice_sent_at: new Date().toISOString(),
        gst_invoice_sent_to: recipients.join(","),
      })
      .eq("id", id);

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        gst_invoice_status: { old: paymentData.gst_invoice_status, new: "sent" },
        gst_invoice_sent_to: { old: paymentData.gst_invoice_sent_to, new: recipients.join(",") },
      },
    });

    // Log email activity for the lead
    if (paymentData.contract?.lead_id) {
      logEmailActivity(supabase, {
        leadId: paymentData.contract.lead_id,
        subject: `GST Invoice ${paymentData.gst_invoice_number || ""} sent`,
        description: `GST Invoice for ${paymentData.contract?.contract_number || "contract"} (₹${Number(paymentData.amount).toLocaleString("en-IN")}) emailed to ${recipients.join(", ")}`,
        createdBy: dbUser.id,
      });
    }

    // ── WhatsApp document (PDF) — only when explicitly requested ──────────────
    const customerPhone = lead?.phone || lead?.mobile;
    if (send_via_whatsapp && customerPhone && paymentData.gst_invoice_path) {
      // Get a signed URL for the PDF (valid 1 hour — long enough for WA delivery)
      supabase.storage
        .from("crm-documents")
        .createSignedUrl(paymentData.gst_invoice_path, 3600)
        .then(({ data: signed }) => {
          if (!signed?.signedUrl) return;
          messaging
            .invoiceDocument(
              customerPhone,
              customerName,
              paymentData.gst_invoice_number || paymentData.contract?.contract_number || "Invoice",
              Number(paymentData.amount).toLocaleString("en-IN"),
              "https://theworkvilla.com",
              signed.signedUrl,
              // [id] is a contract_payments row — see the fetch above.
              { type: "contract_payment", id },
            )
            .catch((e: unknown) => console.error("[messaging] GST invoice WA doc failed:", e));
        })
        .catch((e: unknown) => console.error("[messaging] GST invoice WA signed URL failed:", e));
    }

    return NextResponse.json({ message: "GST invoice emailed successfully" });
  } catch (error) {
    console.error("GST invoice email error:", error);
    return NextResponse.json(
      { error: "Failed to send GST invoice email. Check SMTP_USER/SMTP_PASS configuration." },
      { status: 500 }
    );
  }
}
