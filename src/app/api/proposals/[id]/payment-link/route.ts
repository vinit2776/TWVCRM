import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/proposals/[id]/payment-link
 *
 * Creates a Razorpay payment link for the proposal if one doesn't exist.
 * Returns the existing link if already created. Allows the PDF download
 * to include the payment link without requiring the proposal to be emailed.
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
  if (proposal.razorpay_payment_link_url) {
    return NextResponse.json({
      razorpay_payment_link_url: proposal.razorpay_payment_link_url,
      razorpay_payment_link_id: proposal.razorpay_payment_link_id,
    });
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

  const expireDate = proposal.valid_until
    ? new Date(proposal.valid_until + "T23:59:59Z")
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expireBy = Math.floor(expireDate.getTime() / 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(Number(proposal.total_amount) * 100),
    currency: "INR",
    description: `Proposal ${proposal.proposal_number} — ${proposal.title} — The WorkVilla`,
    reference_id: proposal.proposal_number,
    expire_by: expireBy,
    notify: { sms: !!customerPhone, email: !!customerEmail },
    reminder_enable: true,
    notes: { proposal_id: id, proposal_number: proposal.proposal_number, lead_id: proposal.lead_id },
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
      console.error("[payment-link] Razorpay creation failed:", rzpErr);
      return NextResponse.json({ error: "Failed to create payment link" }, { status: 502 });
    }

    const linkData = await rzpRes.json();
    const razorpayLinkId = linkData.id;
    const razorpayLinkUrl = linkData.short_url;

    // Store on proposal
    await supabase
      .from("proposals")
      .update({
        razorpay_payment_link_id: razorpayLinkId,
        razorpay_payment_link_url: razorpayLinkUrl,
      })
      .eq("id", id);

    return NextResponse.json({
      razorpay_payment_link_url: razorpayLinkUrl,
      razorpay_payment_link_id: razorpayLinkId,
    });
  } catch (err) {
    console.error("[payment-link] Error:", err);
    return NextResponse.json({ error: "Payment link creation failed" }, { status: 500 });
  }
}
