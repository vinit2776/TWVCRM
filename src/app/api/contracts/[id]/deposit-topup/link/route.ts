import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { DEPOSIT_DUE_DAYS } from "@/lib/receivables";
import { escapeHtml } from "@/lib/html";

const ALLOWED_ROLES = ["admin", "manager", "accounts"];
const VALID_CATEGORIES = ["seat_expansion", "risk_buffer", "customer_requested", "renewal_escalation", "other"];
const CUSTOMER_MESSAGE_MAX_LENGTH = 500;

/**
 * POST /api/contracts/[id]/deposit-topup/link — generate a Razorpay payment
 * link for an additional deposit collection and email it to the customer.
 * Mirrors proposals/[id]/deposit-link/route.ts's Razorpay call exactly, but
 * scoped to a contract (not a proposal) since this happens post-activation.
 *
 * No approval gate — matches how the original deposit collection works.
 * Money only actually counts once the webhook confirms payment_link.paid
 * (see payments/webhook/route.ts's deposit_topups branch); this route just
 * creates the pending record and sends the customer somewhere to pay.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ALLOWED_ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "Not authorised to collect an additional deposit" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const category = String(body.category || "");
  const categoryNote = typeof body.category_note === "string" ? body.category_note.trim() : null;
  const appliesToShortfall = body.applies_to_shortfall === true;
  const customerMessage = typeof body.customer_message === "string"
    ? body.customer_message.trim().slice(0, CUSTOMER_MESSAGE_MAX_LENGTH)
    : "";

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "A valid category is required" }, { status: 400 });
  }
  if (!categoryNote || categoryNote.length < 10) {
    return NextResponse.json({ error: "Add an internal note (at least 10 characters) so accounts can book this correctly" }, { status: 400 });
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", contractId)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: rzpSettings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

  const rzpMap: Record<string, string> = {};
  (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

  if (rzpMap.razorpay_enabled !== "true" || !rzpMap.razorpay_key_id || !rzpMap.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay is not enabled" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const customerName = lead ? (lead.company || `${lead.first_name || ""} ${lead.last_name || ""}`.trim()) : "Customer";
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  if (!customerEmail) {
    return NextResponse.json({ error: "Customer email not found on the contract's lead" }, { status: 400 });
  }

  const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(amount * 100),
    currency: "INR",
    description: `Additional Security Deposit — ${contract.contract_number} — The WorkVilla`,
    reference_id: `${contract.contract_number}-DEPTOPUP-${Date.now()}`,
    expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: !!customerPhone, email: true },
    reminder_enable: true,
    notes: { contract_id: contractId, contract_number: contract.contract_number, type: "deposit_topup" },
    callback_url: `${appUrl}/contracts/${contractId}`,
    callback_method: "get",
    customer: { name: customerName, email: customerEmail, ...(customerPhone ? { contact: customerPhone.replace(/\s/g, "") } : {}) },
  };

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
  const linkUrl: string = linkData.short_url;
  const linkId: string = linkData.id;

  const { data: rpcResult, error: rpcError } = await admin.rpc("create_deposit_topup_link", {
    p_contract_id: contractId,
    p_amount: amount,
    p_category: category,
    p_category_note: categoryNote,
    p_applies_to_shortfall: appliesToShortfall,
    p_created_by: actor.id,
    p_razorpay_link_id: linkId,
    p_razorpay_link_url: linkUrl,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not create top-up record" }, { status: 422 });
  }

  // Give the link a due date so AR can age it and the reminder ladder has
  // something to gate on. Set here rather than inside the RPC to avoid
  // changing a function signature already live in production.
  await admin
    .from("deposit_topups")
    .update({
      due_date: new Date(Date.now() + DEPOSIT_DUE_DAYS * 86400000).toISOString().slice(0, 10),
    })
    .eq("id", result.topup_id);

  const customerMessageBlock = customerMessage
    ? `<div style="background:#f0faf5;border-left:3px solid #015E65;border-radius:0 6px 6px 0;padding:10px 14px;margin:0 0 16px;">
         <p style="color:#0f6e56;font-size:13px;margin:0;font-style:italic;">${escapeHtml(customerMessage).replace(/\n/g, "<br/>")}</p>
       </div>`
    : "";

  const subject = `Additional Security Deposit — ${contract.contract_number} — The WorkVilla`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Additional Security Deposit</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Please pay the additional refundable security deposit below for contract <strong>${contract.contract_number}</strong>.</p>
        ${customerMessageBlock}
        <table style="border-collapse:collapse;margin:20px 0;width:100%;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Contract</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${contract.contract_number}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;">Amount</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;font-size:18px;">₹${amount.toLocaleString("en-IN")}</td></tr>
        </table>
        <div style="text-align:center;margin:24px 0;">
          <a href="${linkUrl}" style="background:#015E65;color:white;padding:14px 40px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:15px;">Pay Additional Deposit</a>
          <p style="color:#666;font-size:11px;margin:8px 0 0;">Secure payment via Razorpay</p>
        </div>
        <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>`;

  await resend.emails.send({ from: EMAIL_FROM, replyTo: EMAIL_REPLY_TO, to: [customerEmail], subject, html }).catch(console.error);

  await logAudit(admin, {
    entityType: "deposit_topup",
    entityId: result.topup_id,
    action: "deposit_topup_link_created",
    performedBy: actor.id,
    changes: {
      amount: { old: null, new: amount },
      category: { old: null, new: category },
      contract_id: { old: null, new: contractId },
    },
  });

  return NextResponse.json({
    data: { id: result.topup_id, razorpay_link_url: linkUrl },
  });
}
