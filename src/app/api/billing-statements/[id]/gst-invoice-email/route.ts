import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { logCommunication, resolveAttachmentUrl } from "@/lib/communications-log";
import { messaging } from "@/lib/whatsapp";

// POST — Re-send GST invoice email for a billing-statement-sourced PDF
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  const adminSupabase = await createAdminClient();

  const { data: statement } = await adminSupabase
    .from("billing_statements")
    .select(`
      id, gst_invoice_number, gst_invoice_path, emailed_at, emailed_to, total_amount,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, phone, mobile)
      )
    `)
    .eq("id", id)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  if (!statement.gst_invoice_path) {
    return NextResponse.json({ error: "No GST invoice PDF available for this statement" }, { status: 400 });
  }

  const { data: fileBlob, error: downloadErr } = await adminSupabase.storage
    .from("crm-documents")
    .download(statement.gst_invoice_path);

  if (downloadErr || !fileBlob) {
    return NextResponse.json({ error: "Failed to download GST invoice PDF" }, { status: 500 });
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Client";
  const invoiceNum = (statement.gst_invoice_number as string | null) ?? id.slice(0, 8);
  const filename = `GST-${invoiceNum.replace(/\//g, "-")}.pdf`;
  const senderName = dbUser.full_name || "TWV Team";

  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  const gstTrackingUrl = `${appBaseUrl}/api/billing-statements/${id}/track?type=gst`;

  const emailSubject = `GST Invoice ${invoiceNum} — ${contract?.contract_number || "Contract"}`;
  const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #015E65; padding: 24px 32px;">
          <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
          <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
        </div>
        <div style="padding: 32px;">
          <p style="color: #1a1b1e; font-size: 15px;">Dear ${lead?.first_name || "Client"},</p>
          <p style="color: #333; font-size: 14px;">Please find attached the GST invoice for your membership at The WorkVilla. Below is a summary:</p>
          <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
            <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Invoice Number:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${invoiceNum}</td></tr>
            <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Contract:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${contract?.contract_number || ""}</td></tr>
            <tr><td style="padding: 10px 16px; color: #666;">Company:</td><td style="padding: 10px 16px; color: #333;">${customerName}</td></tr>
          </table>
          <div style="text-align:center;margin:20px 0 4px;">
            <a href="${gstTrackingUrl}" style="background:#f0faf5;color:#015E65;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;border:1px solid #015E65;">View Invoice Online</a>
          </div>
          <p style="color: #333; font-size: 14px;">Please retain this invoice for your tax records. If you have any questions, feel free to reach out.</p>
          <p style="color: #333; font-size: 14px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
          <p style="color: #666; font-size: 12px; margin-top: 16px;">For queries, write to <a href="mailto:contact@theworkvilla.com" style="color: #015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
        </div>
        <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
          <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
          <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
          <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
        </div>
      </div>
    `;

  const { error: emailError } = await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: recipients,
    bcc: "billing@theworkvilla.com",
    subject: emailSubject,
    html: emailHtml,
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  const logged = await logCommunication(adminSupabase, {
    entityType: "billing_statement",
    entityId: id,
    channel: "email",
    recipient: recipients.join(", "),
    subject: emailSubject,
    body: emailHtml,
    attachmentUrl: statement.gst_invoice_path as string,
    attachmentName: filename,
    status: emailError ? "failed" : "sent",
    errorMessage: emailError?.message ?? null,
    sentBy: dbUser.id,
  });

  const commLogEntry = logged ? await resolveAttachmentUrl(logged) : null;

  if (emailError) {
    return NextResponse.json({ error: emailError.message || "Failed to send email", commLogEntry }, { status: 502 });
  }

  await adminSupabase
    .from("billing_statements")
    .update({ emailed_at: new Date().toISOString(), emailed_to: recipients.join(",") })
    .eq("id", id);

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { emailed_to: { old: statement.emailed_to, new: recipients.join(",") } },
  });

  const customerPhone = lead?.phone || lead?.mobile;
  if (send_via_whatsapp && customerPhone) {
    adminSupabase.storage
      .from("crm-documents")
      .createSignedUrl(statement.gst_invoice_path as string, 3600)
      .then(({ data: signed }) => {
        if (!signed?.signedUrl) return;
        messaging
          .invoiceDocument(customerPhone, customerName, invoiceNum, "", "https://theworkvilla.com", signed.signedUrl, { type: "billing_statement", id })
          .catch((e: unknown) => console.error("[messaging] GST invoice WA failed:", e));
      })
      .catch((e: unknown) => console.error("[messaging] GST invoice WA signed URL failed:", e));
  }

  return NextResponse.json({ message: "GST invoice emailed successfully", commLogEntry });
}
