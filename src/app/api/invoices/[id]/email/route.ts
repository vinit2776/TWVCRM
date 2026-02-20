import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/resend";
import { logEmailActivity } from "@/lib/audit";

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

  // Fetch invoice with lead info
  const { data: invoice, error: fetchError } = await supabase
    .from("proforma_invoices")
    .select(
      "*, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company)"
    )
    .eq("id", id)
    .single();

  if (fetchError || !invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  const senderName = sender?.full_name || "TWV Team";

  try {
    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: recipients,
      subject: `Proforma Invoice ${invoice.invoice_number} - ${invoice.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${invoice.lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">Please find attached the proforma invoice <strong>${invoice.invoice_number}</strong> for <strong>${invoice.title}</strong>.</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Invoice:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${invoice.invoice_number}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Amount:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">₹${Number(invoice.total_amount).toLocaleString("en-IN")}</td></tr>
              ${invoice.due_date ? `<tr><td style="padding: 10px 16px; color: #666;">Due Date:</td><td style="padding: 10px 16px; color: #333;">${new Date(invoice.due_date).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
            </table>
            <p style="color: #015E65; font-size: 13px; font-weight: bold; margin: 20px 0 8px;">Bank Details</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">Sree Design Infrastructure Private Limited</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">000905000140</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICIC0000009</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICICI Bank Ltd</td></tr>
              <tr><td style="padding: 8px 16px; color: #666;">Branch</td><td style="padding: 8px 16px; color: #333;">Nungambakkam</td></tr>
            </table>
            <p style="color: #333; font-size: 14px;">Please process the payment at your earliest convenience.</p>
            <p style="color: #333; font-size: 14px;">Best regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
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
          filename: `${invoice.invoice_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
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

    console.log("Invoice email sent:", emailResult?.id, "to:", recipients);

    // Update invoice status to "sent"
    await supabase
      .from("proforma_invoices")
      .update({ status: "sent" })
      .eq("id", id);

    // Log email activity for the lead
    if (invoice.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: invoice.lead_id,
        subject: `Invoice ${invoice.invoice_number} sent`,
        description: `Proforma Invoice "${invoice.title}" (${invoice.invoice_number}) emailed to ${recipients.join(", ")}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error);
    return NextResponse.json(
      { error: "Failed to send email. Check RESEND_API_KEY configuration." },
      { status: 500 }
    );
  }
}
