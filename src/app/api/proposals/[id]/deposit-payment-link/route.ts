import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/proposals/[id]/deposit-payment-link
 *
 * Creates a Razorpay payment link for the security deposit balance
 * (required deposit minus any credit applied) if one doesn't exist yet.
 * Returns the existing link if already created. Does NOT email or
 * WhatsApp the customer — mirrors /payment-link's "get or create" role
 * for the deposit, so the link shows up on the proposal page as soon as
 * it can be generated, without requiring an explicit send first.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: proposal, error: fetchError } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(first_name, last_name, email, phone, mobile)")
    .eq("id", id)
    .single();

  if (fetchError || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  // Already has a link — return it
  if (proposal.deposit_razorpay_link_url) {
    return NextResponse.json({
      deposit_razorpay_link_url: proposal.deposit_razorpay_link_url,
      deposit_razorpay_link_id: proposal.deposit_razorpay_link_id,
    });
  }

  if (proposal.deposit_payment_status !== "pending") {
    return NextResponse.json({ error: "No pending deposit for this proposal" }, { status: 400 });
  }

  const requiredDeposit = Number(proposal.security_deposit_amount || 0);
  const creditApplied = Number(proposal.deposit_credit_amount || 0);
  const depositAmount = Math.max(0, requiredDeposit - creditApplied);
  if (depositAmount <= 0) {
    return NextResponse.json({ error: "Deposit amount is zero" }, { status: 400 });
  }

  // Check Razorpay settings
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : undefined;
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(depositAmount * 100),
    currency: "INR",
    description: `Security Deposit — ${proposal.proposal_number} — The WorkVilla`,
    reference_id: `${proposal.proposal_number}-DEP-${Date.now()}`,
    expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    notify: { sms: !!customerPhone, email: !!customerEmail },
    reminder_enable: true,
    notes: { proposal_id: id, proposal_number: proposal.proposal_number, type: "security_deposit" },
    callback_url: `${appUrl}/proposals`,
    callback_method: "get",
  };

  if (customerName || customerEmail || customerPhone) {
    payload.customer = {};
    if (customerName) payload.customer.name = customerName;
    if (customerEmail) payload.customer.email = customerEmail;
    if (customerPhone) payload.customer.contact = customerPhone.replace(/\s/g, "");
  }

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!rzpRes.ok) {
      const rzpErr = await rzpRes.json().catch(() => null);
      console.error("[deposit-payment-link] Razorpay creation failed:", rzpErr);
      return NextResponse.json({ error: rzpErr?.error?.description || "Failed to create payment link" }, { status: 502 });
    }

    const linkData = await rzpRes.json();
    const depositLinkId = linkData.id;
    const depositLinkUrl = linkData.short_url;

    await supabase
      .from("proposals")
      .update({
        deposit_razorpay_link_id: depositLinkId,
        deposit_razorpay_link_url: depositLinkUrl,
      })
      .eq("id", id);

    return NextResponse.json({
      deposit_razorpay_link_url: depositLinkUrl,
      deposit_razorpay_link_id: depositLinkId,
    });
  } catch (err) {
    console.error("[deposit-payment-link] Error:", err);
    return NextResponse.json({ error: "Payment link creation failed" }, { status: 500 });
  }
}
