import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logEmailActivity } from "@/lib/audit";
import { buildAddendumPdfBuffer } from "@/lib/addendum-generator";

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

  if (!recipients || recipients.length === 0) {
    return NextResponse.json({ error: "At least one recipient email is required" }, { status: 400 });
  }
  if (!pdfBuffer || pdfBuffer.length === 0) {
    return NextResponse.json({ error: "PDF data is required" }, { status: 400 });
  }

  // Fetch contract with lead info
  const { data: contract, error: fetchError } = await supabase
    .from("contracts")
    .select("*, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .eq("id", id)
    .single();

  if (fetchError || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  // Renewal contracts also need their addendum attached alongside the base agreement.
  const addendumBuffer = await buildAddendumPdfBuffer(supabase, id);

  try {
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [recipients[0]],
      ...(recipients.length > 1 ? { cc: recipients.slice(1) } : {}),
      subject: `Membership Agreement ${contract.contract_number} - ${contract.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${contract.lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">We are pleased to share your Membership Agreement for The WorkVilla. Please find the agreement <strong>${contract.contract_number}</strong> for <strong>${contract.title}</strong>${addendumBuffer ? ", along with the renewal addendum," : ""} attached to this email.</p>
            <p style="color: #333; font-size: 14px;">Here is a summary of your membership details:</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Agreement:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${contract.contract_number}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Monthly Fee:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${Number(contract.total_amount).toLocaleString("en-IN")}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Start Date:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${new Date(contract.start_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" })}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666;">Tenure:</td><td style="padding: 10px 16px; color: #333;">${contract.tenure_months} months</td></tr>
            </table>
            <p style="color: #333; font-size: 14px;">Please review the attached agreement carefully. Upon your acceptance, we will proceed with activation of your workspace membership.</p>
            <p style="color: #015E65; font-size: 13px; font-weight: bold; margin: 20px 0 8px;">Bank Details</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">Sree Design Infrastructure Private Limited</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">000905000140</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICIC0000009</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICICI Bank Ltd</td></tr>
              <tr><td style="padding: 8px 16px; color: #666;">Branch</td><td style="padding: 8px 16px; color: #333;">Nungambakkam</td></tr>
            </table>
            <p style="color: #333; font-size: 14px;">We look forward to having you at The WorkVilla.</p>
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
          filename: `${contract.contract_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
        ...(addendumBuffer
          ? [
              {
                filename: `Addendum-${contract.contract_number}.pdf`,
                content: addendumBuffer,
                contentType: "application/pdf",
              },
            ]
          : []),
      ],
    });

    // Resend SDK returns { data, error } — does NOT throw on failure
    if (emailError) {
      console.error("Resend email error:", emailError);
      return NextResponse.json(
        { error: emailError.message || "Resend failed to send email" },
        { status: 502 }
      );
    }

    console.log("Contract email sent:", emailResult?.id, "to:", recipients);

    // Update contract status to "sent" and set sent_at
    await supabase
      .from("contracts")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);

    // Log email activity for the lead
    if (contract.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: contract.lead_id,
        subject: `Agreement ${contract.contract_number} sent`,
        description: `Membership Agreement "${contract.title}" (${contract.contract_number}) emailed to ${recipients.join(", ")}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error);
    return NextResponse.json(
      { error: "Failed to send email. Check SMTP_USER/SMTP_PASS configuration." },
      { status: 500 }
    );
  }
}
