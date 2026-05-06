import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";

export const maxDuration = 30;

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
    .select("id, full_name, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Parse request — supports FormData (binary PDF) or JSON (base64 PDF)
  let recipients: string[];
  let pdfBuffer: Buffer;
  let saveEmail = false;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    recipients = JSON.parse((formData.get("recipients") as string) || "[]");
    saveEmail = formData.get("save_email") === "true";
    const pdfFile = formData.get("pdf") as File;
    if (!pdfFile) return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } else {
    const body = await request.json();
    recipients = body.recipients;
    saveEmail = body.save_email === true;
    pdfBuffer = Buffer.from(body.pdfBase64, "base64");
  }

  if (!recipients || recipients.length === 0) {
    return NextResponse.json({ error: "At least one recipient email is required" }, { status: 400 });
  }

  if (!pdfBuffer || pdfBuffer.length === 0) {
    return NextResponse.json({ error: "PDF data is required" }, { status: 400 });
  }

  // Fetch PO with vendor info
  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .select(
      `*, procurement_vendors(id, name, contact_name, contact_email), locations(id, name)`
    )
    .eq("id", id)
    .single();

  if (poError || !po) {
    return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vendor = po.procurement_vendors as any;
  const vendorName = vendor?.name || "Vendor";
  const vendorContact = vendor?.contact_name || vendorName;
  const senderName = dbUser.full_name || "TWV Procurement";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locationName = (po.locations as any)?.name || "";
  const totalWithGst = Number(po.total_amount_with_gst ?? po.total_ordered_amount ?? 0);

  // Optionally save email to vendor record for future use
  if (saveEmail && vendor?.id && recipients[0]) {
    await supabase
      .from("procurement_vendors")
      .update({ contact_email: recipients[0] })
      .eq("id", vendor.id);
  }

  try {
    const { data: emailResult, error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      subject: `Purchase Order ${po.po_number} — The WorkVilla`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Purchase Order</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${vendorContact},</p>
            <p style="color: #333; font-size: 14px;">Please find attached our Purchase Order <strong>${po.po_number}</strong>. Kindly review and acknowledge receipt.</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #f0faf5; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">PO Number:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${po.po_number}</td></tr>
              ${locationName ? `<tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Delivery Location:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${locationName}</td></tr>` : ""}
              ${po.expected_delivery_date ? `<tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Expected Delivery:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${new Date(po.expected_delivery_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" })}</td></tr>` : ""}
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Order Amount:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${"\u20B9"}${totalWithGst.toLocaleString("en-IN")}</td></tr>
              ${po.payment_terms ? `<tr><td style="padding: 10px 16px; color: #666;">Payment Terms:</td><td style="padding: 10px 16px; color: #333;">${po.payment_terms} days</td></tr>` : ""}
            </table>
            <p style="color: #333; font-size: 14px;">Please confirm acceptance of this order at your earliest convenience. For any queries, contact us at the details below.</p>
            <p style="color: #333; font-size: 14px;">Regards,<br/><strong>${senderName}</strong><br/>The WorkVilla — Procurement</p>
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
          filename: `${po.po_number}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    if (emailError) {
      console.error("PO email error:", emailError);
      return NextResponse.json({ error: emailError.message || "Failed to send email" }, { status: 502 });
    }

    console.log("PO email sent:", emailResult?.id, "to:", recipients);

    await logAudit(supabase, {
      entityType: "purchase_order",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        emailed_to: { old: null, new: recipients.join(", ") },
      },
    });

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("PO email send error:", message);
    return NextResponse.json({ error: `Failed to send email: ${message}` }, { status: 500 });
  }
}
