import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/prepaid-purchases/[id]/payment-link
 *
 * Create or resend a Razorpay payment link for a pending prepaid purchase.
 * If a link already exists, resends notifications via Razorpay's notify endpoints.
 * If no link exists, creates a new one.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Fetch the purchase with package and lead details
  const { data: purchase, error: purchaseErr } = await supabase
    .from("prepaid_purchases")
    .select(`
      *,
      package:prepaid_packages(id, name, price),
      lead:leads(id, first_name, last_name, email, phone)
    `)
    .eq("id", id)
    .single();

  if (purchaseErr || !purchase) {
    return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
  }

  // Fetch Razorpay credentials via service-role
  const adminSupabase = await createAdminClient();
  const { data: settings } = await adminSupabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);

  const creds: Record<string, string> = {};
  (settings || []).forEach((s: { key: string; value: string }) => { creds[s.key] = s.value; });

  if (creds.razorpay_enabled !== "true") {
    return NextResponse.json({ error: "Razorpay is not enabled" }, { status: 400 });
  }
  if (!creds.razorpay_key_id || !creds.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay credentials not configured" }, { status: 400 });
  }

  const auth = Buffer.from(`${creds.razorpay_key_id}:${creds.razorpay_key_secret}`).toString("base64");

  // Resolve customer contact
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = purchase.lead as Record<string, any> | null;
  const customerName = lead?.first_name ? `${lead.first_name} ${lead.last_name}` : purchase.company_name || undefined;
  const customerEmail: string | undefined = lead?.email || undefined;
  const rawPhone: string | undefined = lead?.phone || undefined;
  const customerPhone = (() => {
    if (!rawPhone) return undefined;
    let phone = String(rawPhone).replace(/[\s-]/g, "");
    if (phone.startsWith("+")) phone = phone.substring(1);
    if (!phone.startsWith("91") && phone.length === 10) phone = "91" + phone;
    return "+" + phone;
  })();

  // If a link already exists — just resend notifications
  if (purchase.razorpay_payment_link_id && purchase.razorpay_payment_link_url) {
    const linkId = purchase.razorpay_payment_link_id;
    const rzpBase = `https://api.razorpay.com/v1/payment_links/${linkId}/notify`;
    const headers = { Authorization: `Basic ${auth}` };

    await Promise.allSettled([
      customerPhone ? fetch(`${rzpBase}/sms`, { method: "POST", headers }) : Promise.resolve(null),
      customerEmail ? fetch(`${rzpBase}/email`, { method: "POST", headers }) : Promise.resolve(null),
    ]);

    return NextResponse.json({
      data: {
        payment_link_url: purchase.razorpay_payment_link_url,
        already_exists: true,
      },
    });
  }

  // No existing link — create a new one
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = purchase.package as Record<string, any> | null;
  const amountInPaise = Math.round(Number(pkg?.price || purchase.price_paid) * 100);
  const expireBy = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  const rzpPayload: Record<string, unknown> = {
    amount: amountInPaise,
    currency: "INR",
    description: `Package: ${pkg?.name || "Prepaid Package"} — The WorkVilla`,
    reference_id: purchase.id,
    expire_by: expireBy,
    notify: {
      sms: !!customerPhone,
      email: !!customerEmail,
    },
    reminder_enable: true,
    notes: {
      purchase_id: purchase.id,
      package_name: pkg?.name || "",
    },
  };

  if (customerName || customerEmail || customerPhone) {
    rzpPayload.customer = {
      ...(customerName ? { name: customerName } : {}),
      ...(customerEmail ? { email: customerEmail } : {}),
      ...(customerPhone ? { contact: customerPhone } : {}),
    };
  }

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(rzpPayload),
    });

    if (!rzpRes.ok) {
      const rzpErr = await rzpRes.json().catch(() => null);
      console.error("Razorpay error:", rzpErr);
      return NextResponse.json({
        error: rzpErr?.error?.description || "Failed to create payment link",
      }, { status: 500 });
    }

    const linkData = await rzpRes.json();

    await supabase
      .from("prepaid_purchases")
      .update({
        razorpay_payment_link_id: linkData.id,
        razorpay_payment_link_url: linkData.short_url,
      })
      .eq("id", id);

    return NextResponse.json({
      data: {
        payment_link_url: linkData.short_url,
        already_exists: false,
      },
    });
  } catch (e) {
    console.error("Failed to create payment link for purchase:", e);
    return NextResponse.json({
      error: e instanceof Error ? e.message : "Failed to create payment link",
    }, { status: 500 });
  }
}
