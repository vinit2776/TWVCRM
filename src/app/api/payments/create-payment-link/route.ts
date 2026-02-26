import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// POST — create a Razorpay Payment Link for a booking
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { booking_id } = body;

  if (!booking_id) {
    return NextResponse.json({ error: "booking_id is required" }, { status: 400 });
  }

  // Fetch Razorpay settings via service-role — secrets must be accessible
  // regardless of the requesting user's role (server-side only, never exposed to client).
  const adminSupabase = await createAdminClient();
  const { data: settings } = await adminSupabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);

  const creds: Record<string, string> = {};
  (settings || []).forEach((s) => { creds[s.key] = s.value; });

  if (creds.razorpay_enabled !== "true") {
    return NextResponse.json({ error: "Razorpay is not enabled" }, { status: 400 });
  }

  if (!creds.razorpay_key_id || !creds.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay credentials not configured" }, { status: 400 });
  }

  // Fetch the booking with customer details
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, total_amount, payment_status, payment_token, customer_type, razorpay_payment_link_id, razorpay_payment_link_url, space:spaces!bookings_space_id_fkey(name), lead:leads!bookings_lead_id_fkey(first_name, last_name, email, phone), guest_name, guest_email, guest_phone, status")
    .eq("id", booking_id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "Cannot create payment link for a cancelled booking" }, { status: 400 });
  }

  // If a payment link already exists and is usable, return it
  if (booking.razorpay_payment_link_id && booking.razorpay_payment_link_url) {
    return NextResponse.json({
      data: {
        payment_link_id: booking.razorpay_payment_link_id,
        payment_link_url: booking.razorpay_payment_link_url,
        already_exists: true,
      },
    });
  }

  // Calculate balance due
  const { data: payments } = await supabase
    .from("booking_payments")
    .select("amount, status")
    .eq("booking_id", booking_id)
    .eq("status", "verified");

  const totalPaid = (payments || []).reduce((s, p) => s + Number(p.amount), 0);
  const balanceDue = Number(booking.total_amount) - totalPaid;

  if (balanceDue <= 0) {
    return NextResponse.json({ error: "No balance due for this booking" }, { status: 400 });
  }

  // Prepare customer details
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = booking.lead as any;
  const customerName = lead?.first_name
    ? `${lead.first_name} ${lead.last_name}`
    : booking.guest_name || "Guest";
  const customerEmail = lead?.email || booking.guest_email || undefined;
  const customerPhone = lead?.phone || booking.guest_phone || undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spaceName = (booking.space as any)?.name || "Conference Room";

  const amountInPaise = Math.round(balanceDue * 100);
  const auth = Buffer.from(`${creds.razorpay_key_id}:${creds.razorpay_key_secret}`).toString("base64");

  // Expire link in 7 days
  const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  // Build Razorpay Payment Link payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: amountInPaise,
    currency: "INR",
    description: `Booking ${booking.booking_number} — ${spaceName} — The WorkVilla`,
    reference_id: booking.booking_number || booking_id,
    expire_by: expireBy,
    notify: {
      sms: !!customerPhone,
      email: !!customerEmail,
    },
    reminder_enable: true,
    notes: {
      booking_id: booking_id,
      booking_number: booking.booking_number,
      space: spaceName,
      customer_name: customerName,
    },
  };

  // Razorpay requires callback_url for payment links
  // Note: .trim() is critical — env vars can have trailing newlines that break URL validation
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || `https://${(process.env.VERCEL_URL || "twv-crm.vercel.app").trim()}`).trim();
  const token = (booking as Record<string, unknown>).payment_token;
  payload.callback_url = `${appUrl}/pay/${token || booking_id}?razorpay_callback=true`;
  payload.callback_method = "get";

  // Add customer details if available
  if (customerName || customerEmail || customerPhone) {
    payload.customer = {};
    if (customerName) payload.customer.name = customerName;
    if (customerEmail) payload.customer.email = customerEmail;
    if (customerPhone) {
      // Razorpay expects phone in format "+91XXXXXXXXXX" or "91XXXXXXXXXX"
      let phone = customerPhone.replace(/[\s-]/g, "");
      if (phone.startsWith("+")) phone = phone.substring(1);
      if (!phone.startsWith("91") && phone.length === 10) phone = "91" + phone;
      payload.customer.contact = "+" + phone;
    }
  }

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!rzpRes.ok) {
      const rzpErr = await rzpRes.json().catch(() => null);
      console.error("Razorpay Payment Link error:", rzpErr);
      return NextResponse.json({
        error: rzpErr?.error?.description || "Failed to create Razorpay payment link",
      }, { status: 500 });
    }

    const linkData = await rzpRes.json();

    // Store the payment link details on the booking
    await supabase
      .from("bookings")
      .update({
        razorpay_payment_link_id: linkData.id,
        razorpay_payment_link_url: linkData.short_url,
      })
      .eq("id", booking_id);

    return NextResponse.json({
      data: {
        payment_link_id: linkData.id,
        payment_link_url: linkData.short_url,
        amount: balanceDue,
        expires_at: new Date(expireBy * 1000).toISOString(),
      },
    });
  } catch (e) {
    console.error("Failed to create payment link:", e);
    return NextResponse.json({
      error: e instanceof Error ? e.message : "Failed to create payment link",
    }, { status: 500 });
  }
}
