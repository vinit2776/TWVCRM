import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only Accounts or Admin can send payment confirmations" }, { status: 403 });
  }

  // Fixed CC recipients for all payment confirmation emails
  const FIXED_CC = ["admin@stonecolour.com", "admin@theworkvilla.com"];

  // Fetch bill with vendor and PO
  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(`
      *,
      procurement_vendors(id, name, contact_name, contact_email),
      purchase_orders(id, po_number)
    `)
    .eq("id", id)
    .single();

  if (error || !bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  if (bill.payment_status === "unpaid") {
    return NextResponse.json({ error: "No payment has been recorded yet for this bill" }, { status: 422 });
  }

  const vendor = bill.procurement_vendors as { id: string; name: string; contact_name?: string; contact_email?: string } | null;

  if (!vendor) {
    return NextResponse.json({ error: "Vendor not found for this bill" }, { status: 404 });
  }

  // Always sendable — if vendor email is missing, confirmation goes to fixed CC addresses

  const po = bill.purchase_orders as { id: string; po_number: string } | null;

  const paymentModeLabel: Record<string, string> = {
    bank_transfer: "Bank Transfer",
    neft: "NEFT",
    rtgs: "RTGS",
    imps: "IMPS",
    cheque: "Cheque",
    cash: "Cash / Petty Cash",
  };

  const baseAmount  = Number(bill.total_amount ?? 0);
  const gstAmount   = Number(bill.gst_amount ?? 0);
  const invoiceTotal = baseAmount + gstAmount;          // total payable incl. GST
  const amountPaid  = Number(bill.amount_paid ?? 0);
  const outstanding = Math.max(0, invoiceTotal - amountPaid);
  const isFullyPaid = outstanding <= 0;
  const hasGst      = gstAmount > 0;

  const formattedDate = bill.payment_date
    ? new Date(bill.payment_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" })
    : new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background: #015E65; padding: 24px 32px;">
        <h1 style="color: #fff; margin: 0; font-size: 22px;">Payment Confirmation</h1>
        <p style="color: #a7f3d0; margin: 6px 0 0; font-size: 14px;">The WorkVilla</p>
      </div>
      <div style="padding: 28px 32px;">
        <p style="color: #374151; font-size: 15px; margin: 0 0 20px;">
          Dear ${vendor.contact_name ?? vendor.name},
        </p>
        <p style="color: #374151; font-size: 15px; margin: 0 0 24px;">
          We are pleased to confirm that a payment has been processed against your invoice. Please find the details below.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <tr style="background: #f3f4f6;">
            <td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb; width: 45%;">Bill Reference</td>
            <td style="padding: 10px 16px; font-weight: bold; font-size: 13px; color: #015E65; border-bottom: 1px solid #e5e7eb;">${bill.bill_number}</td>
          </tr>
          ${bill.invoice_number ? `<tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Your Invoice No.</td><td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">${bill.invoice_number}</td></tr>` : ""}
          ${po ? `<tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Purchase Order</td><td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">${po.po_number}</td></tr>` : ""}
          <tr style="background: #f3f4f6;">
            <td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Payment Date</td>
            <td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">${formattedDate}</td>
          </tr>
          <tr>
            <td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Payment Mode</td>
            <td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">${paymentModeLabel[bill.payment_mode ?? ""] ?? bill.payment_mode ?? "—"}</td>
          </tr>
          <tr style="background: #f3f4f6;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Reference / UTR</td><td style="padding: 10px 16px; font-size: 13px; font-weight: bold; color: #374151; border-bottom: 1px solid #e5e7eb;">${bill.payment_reference ?? "—"}</td></tr>
          ${hasGst ? `
          <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Invoice Amount (excl. GST)</td><td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">₹${baseAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px; border-bottom: 1px solid #e5e7eb;">GST</td><td style="padding: 10px 16px; font-size: 13px; color: #374151; border-bottom: 1px solid #e5e7eb;">₹${gstAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          <tr style="background: #f3f4f6;"><td style="padding: 10px 16px; color: #374151; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Invoice Total (incl. GST)</td><td style="padding: 10px 16px; font-size: 13px; font-weight: bold; color: #374151; border-bottom: 1px solid #e5e7eb;">₹${invoiceTotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          ` : `
          <tr style="background: #f3f4f6;"><td style="padding: 10px 16px; color: #374151; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Invoice Total</td><td style="padding: 10px 16px; font-size: 13px; font-weight: bold; color: #374151; border-bottom: 1px solid #e5e7eb;">₹${invoiceTotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          `}
          <tr style="background: #f0fdf4;">
            <td style="padding: 12px 16px; color: #166534; font-size: 14px; font-weight: bold; border-bottom: 1px solid #bbf7d0;">Amount Paid</td>
            <td style="padding: 12px 16px; font-size: 16px; font-weight: bold; color: #15803d; border-bottom: 1px solid #bbf7d0;">₹${amountPaid.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
          </tr>
          ${!isFullyPaid ? `<tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Outstanding Balance</td><td style="padding: 10px 16px; font-size: 13px; color: #b45309; font-weight: bold;">₹${outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>` : `<tr><td colspan="2" style="padding: 10px 16px; color: #15803d; font-size: 13px; text-align: center; font-weight: bold;">✓ Invoice fully settled</td></tr>`}
        </table>
        <p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin: 0 0 8px;">
          Please retain this confirmation for your records. If you have any questions regarding this payment, please contact our Accounts team by replying to this email.
        </p>
        <p style="color: #6b7280; font-size: 13px; margin: 0;">
          Sent by: ${dbUser.full_name ?? "Accounts Team"} — The WorkVilla
        </p>
      </div>
      <div style="background: #f9fafb; padding: 16px 32px; border-top: 1px solid #e5e7eb; text-align: center;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">The WorkVilla · accounts@theworkvilla.com</p>
      </div>
    </div>
  `;

  const primaryEmail = vendor?.contact_email?.trim() || null;

  // Rule 1: vendor email available → send to vendor, CC fixed admins
  // Rule 2: vendor email missing → send directly to fixed admins (no CC field)
  const toAddrs: string[] = primaryEmail ? [primaryEmail] : FIXED_CC;
  const ccAddrs: string[] | undefined = primaryEmail ? FIXED_CC : undefined;
  const sentToVendor = !!primaryEmail;

  const { error: emailError } = await resend.emails.send({
    from: EMAIL_FROM,
    to: toAddrs,
    cc: ccAddrs,
    replyTo: EMAIL_REPLY_TO,
    subject: `Payment Confirmation — ${bill.bill_number}`,
    html,
  });

  if (emailError) {
    return NextResponse.json({ error: emailError.message || "Failed to send email" }, { status: 502 });
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: id,
    action: "email_sent",
    performedBy: dbUser.id,
    changes: {
      sent_to_vendor: { old: null, new: sentToVendor },
      to: { old: null, new: toAddrs.join(", ") },
      cc: { old: null, new: ccAddrs ? ccAddrs.join(", ") : null },
      subject: { old: null, new: `Payment Confirmation — ${bill.bill_number}` },
    } as Record<string, { old: unknown; new: unknown }>,
  });

  return NextResponse.json({ message: "Payment confirmation sent successfully" });
}
