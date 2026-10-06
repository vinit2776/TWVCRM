import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS, RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";

/**
 * POST /api/proposals/[id]/monthly-link
 * Creates a Razorpay payment link for the first month's charge (total_amount)
 * and emails it to the customer. Manual trigger — not auto-created on proposal send.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (proposal.razorpay_payment_link_url) {
    return NextResponse.json({ payment_link_url: proposal.razorpay_payment_link_url, message: "Link already exists" });
  }

  const totalAmount = Number(proposal.total_amount || 0);
  if (totalAmount <= 0) {
    return NextResponse.json({ error: "Proposal amount is zero" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  const adminSupabase = createAdminClient();
  const { data: rzpSettings } = await adminSupabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

  const rzpMap: Record<string, string> = {};
  (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

  if (rzpMap.razorpay_enabled !== "true" || !rzpMap.razorpay_key_id || !rzpMap.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay is not enabled" }, { status: 400 });
  }

  const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(totalAmount * 100),
    currency: "INR",
    description: `Monthly Charge — ${proposal.proposal_number} — The WorkVilla`,
    reference_id: `${proposal.proposal_number}-MON`,
    expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: !!customerPhone, email: !!customerEmail },
    reminder_enable: true,
    notes: { proposal_id: id, proposal_number: proposal.proposal_number, type: "monthly_charge" },
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

  if (!rzpRes.ok) {
    const err = await rzpRes.json().catch(() => null);
    return NextResponse.json({ error: err?.error?.description || "Failed to create payment link" }, { status: 500 });
  }

  const linkData = await rzpRes.json();

  await supabase
    .from("proposals")
    .update({
      razorpay_payment_link_id: linkData.id,
      razorpay_payment_link_url: linkData.short_url,
    })
    .eq("id", id);

  // Email customer
  if (customerEmail) {
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject: `Monthly Charge Payment — ${proposal.proposal_number} — The WorkVilla`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Monthly Charge Collection</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Please pay the first month's charge for your workspace at The WorkVilla.</p>
            <table style="border-collapse:collapse;margin:20px 0;width:100%;background:#f0faf5;border-radius:6px;">
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Proposal</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${proposal.proposal_number}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;">Monthly Charge</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;font-size:18px;">₹${totalAmount.toLocaleString("en-IN")}</td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${linkData.short_url}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Monthly Charge</a>
              <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
            </div>
            <p style="color:#015E65;font-size:13px;font-weight:bold;margin:20px 0 8px;">Bank Transfer</p>
            <table style="border-collapse:collapse;width:100%;background:#f0faf5;border-radius:6px;">
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Account</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountName}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">A/C No</td><td style="padding:8px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${COMPANY_BANK_DETAILS.accountNumber}</td></tr>
              <tr><td style="padding:8px 16px;color:#666;">IFSC</td><td style="padding:8px 16px;color:#333;">${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
            </table>
            <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>
      `,
    }).catch(console.error);
  }

  return NextResponse.json({
    payment_link_url: linkData.short_url,
    payment_link_id: linkData.id,
    amount: totalAmount,
  });
}
