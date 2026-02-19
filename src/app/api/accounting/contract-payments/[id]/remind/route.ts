import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/resend";
import { logAudit } from "@/lib/audit";

// POST — send payment reminder email
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
  const { recipients } = body as { recipients: string[] };

  if (!recipients || recipients.length === 0) {
    return NextResponse.json({ error: "At least one recipient email is required" }, { status: 400 });
  }

  // Fetch payment with contract and lead info
  const { data: payment, error: fetchError } = await supabase
    .from("contract_payments")
    .select(
      "*, contract:contracts!contract_payments_contract_id_fkey(id, contract_number, title, monthly_membership_fee, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company))"
    )
    .eq("id", id)
    .single();

  if (fetchError || !payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  const senderName = dbUser.full_name || "TWV Team";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentData = payment as any;
  const lead = paymentData.contract?.lead;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Client";

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: recipients,
      subject: `Payment Reminder — ${paymentData.contract?.contract_number || "Contract"} — ₹${Number(paymentData.amount).toLocaleString("en-IN")}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #015E65; padding: 24px 32px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
            <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding: 32px;">
            <p style="color: #1a1b1e; font-size: 15px;">Dear ${lead?.first_name || "Client"},</p>
            <p style="color: #333; font-size: 14px;">This is a gentle reminder regarding the outstanding payment for your membership at The WorkVilla.</p>
            <table style="border-collapse: collapse; margin: 20px 0; width: 100%; background: #fef3c7; border-radius: 6px;">
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Contract:</td><td style="padding: 10px 16px; font-weight: bold; color: #015E65; border-bottom: 1px solid #e5e7eb;">${paymentData.contract?.contract_number || ""}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Company:</td><td style="padding: 10px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">${customerName}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Amount Due:</td><td style="padding: 10px 16px; font-weight: bold; color: #dc2626; border-bottom: 1px solid #e5e7eb;">₹${Number(paymentData.amount).toLocaleString("en-IN")}</td></tr>
              <tr><td style="padding: 10px 16px; color: #666;">Payment Date:</td><td style="padding: 10px 16px; color: #333;">${new Date(paymentData.payment_date).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</td></tr>
            </table>
            <p style="color: #015E65; font-size: 13px; font-weight: bold; margin: 20px 0 8px;">Bank Details for Payment</p>
            <table style="border-collapse: collapse; width: 100%; background: #f0faf5; border-radius: 6px; margin-bottom: 20px;">
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb; width: 40%;">Account Name</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">Sree Design Infrastructure Private Limited</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Account Number</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">000905000140</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">IFSC Code</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICIC0000009</td></tr>
              <tr><td style="padding: 8px 16px; color: #666; border-bottom: 1px solid #e5e7eb;">Bank</td><td style="padding: 8px 16px; color: #333; border-bottom: 1px solid #e5e7eb;">ICICI Bank Ltd</td></tr>
              <tr><td style="padding: 8px 16px; color: #666;">Branch</td><td style="padding: 8px 16px; color: #333;">Nungambakkam</td></tr>
            </table>
            <p style="color: #333; font-size: 14px;">Please process the payment at your earliest convenience. If you have already made the payment, kindly ignore this reminder.</p>
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
    });

    // Update reminder_sent_at on the payment
    await supabase
      .from("contract_payments")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", id);

    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { reminder_sent_at: { old: paymentData.reminder_sent_at, new: new Date().toISOString() } },
    });

    return NextResponse.json({ message: "Reminder sent successfully" });
  } catch (error) {
    console.error("Payment reminder email error:", error);
    return NextResponse.json(
      { error: "Failed to send reminder email. Check RESEND_API_KEY configuration." },
      { status: 500 }
    );
  }
}
