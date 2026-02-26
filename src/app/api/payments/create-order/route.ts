import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// POST — create a Razorpay order for a booking payment
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const { booking_id, amount } = body;

  if (!booking_id || !amount || amount <= 0) {
    return NextResponse.json({ error: "booking_id and positive amount are required" }, { status: 400 });
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

  // Verify the booking exists
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, booking_number, total_amount")
    .eq("id", booking_id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Create Razorpay order
  const amountInPaise = Math.round(amount * 100);
  const auth = Buffer.from(`${creds.razorpay_key_id}:${creds.razorpay_key_secret}`).toString("base64");

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: "INR",
        receipt: booking.booking_number || booking_id,
        notes: {
          booking_id,
          booking_number: booking.booking_number,
        },
      }),
    });

    if (!rzpRes.ok) {
      const rzpErr = await rzpRes.json().catch(() => null);
      return NextResponse.json({
        error: rzpErr?.error?.description || "Failed to create Razorpay order",
      }, { status: 500 });
    }

    const order = await rzpRes.json();

    // Create a pending booking_payment record with the order ID
    const { data: payment, error } = await supabase
      .from("booking_payments")
      .insert({
        booking_id,
        amount,
        payment_mode: "razorpay",
        status: "pending",
        razorpay_order_id: order.id,
        created_by: dbUser.id,
      })
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      data: {
        order_id: order.id,
        payment_record_id: payment.id,
        razorpay_key_id: creds.razorpay_key_id,
        amount: amountInPaise,
        currency: "INR",
      },
    });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : "Failed to create order",
    }, { status: 500 });
  }
}
