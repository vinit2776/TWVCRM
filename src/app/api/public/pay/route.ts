import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — Fetch booking payment details by payment token (no auth)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 });

  const supabase = await createClient();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, total_amount, payment_status, customer_type, space:spaces!bookings_space_id_fkey(name), lead:leads!bookings_lead_id_fkey(first_name, last_name, email, phone), guest_name, guest_email, guest_phone, status")
    .eq("payment_token", token)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Invalid or expired payment link" }, { status: 404 });
  }

  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "This booking has been cancelled" }, { status: 400 });
  }

  // Fetch verified payments
  const { data: payments } = await supabase
    .from("booking_payments")
    .select("amount, payment_mode, status")
    .eq("booking_id", booking.id)
    .eq("status", "verified");

  const totalPaid = (payments || []).reduce((s, p) => s + Number(p.amount), 0);
  const balanceDue = Number(booking.total_amount) - totalPaid;

  return NextResponse.json({
    data: {
      booking_id: booking.id,
      booking_number: booking.booking_number,
      booking_date: booking.booking_date,
      start_time: booking.start_time,
      end_time: booking.end_time,
      total_amount: Number(booking.total_amount),
      total_paid: totalPaid,
      balance_due: balanceDue,
      payment_status: booking.payment_status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      space_name: (booking.space as any)?.name || "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customer_name: (booking.lead as any)?.first_name ? `${(booking.lead as any).first_name} ${(booking.lead as any).last_name}` : booking.guest_name || "Guest",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customer_email: (booking.lead as any)?.email || booking.guest_email || null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customer_phone: (booking.lead as any)?.phone || booking.guest_phone || null,
      is_paid: balanceDue <= 0,
    },
  });
}

// POST — Record a payment via public link
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { token, amount, payment_mode, payment_reference, razorpay_payment_id, razorpay_order_id, razorpay_signature } = body;

  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 });

  const supabase = await createClient();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, total_amount, status")
    .eq("payment_token", token)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Invalid or expired payment link" }, { status: 404 });
  }

  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "This booking has been cancelled" }, { status: 400 });
  }

  const { data: payment, error: insertError } = await supabase
    .from("booking_payments")
    .insert({
      booking_id: booking.id,
      amount: amount || Number(booking.total_amount),
      payment_mode: payment_mode || "razorpay",
      payment_reference: payment_reference || null,
      razorpay_payment_id: razorpay_payment_id || null,
      razorpay_order_id: razorpay_order_id || null,
      razorpay_signature: razorpay_signature || null,
      status: razorpay_payment_id ? "verified" : "pending",
    })
    .select()
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Check if fully paid → update booking
  const { data: allPayments } = await supabase
    .from("booking_payments")
    .select("amount")
    .eq("booking_id", booking.id)
    .eq("status", "verified");

  const totalPaid = (allPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  if (totalPaid >= Number(booking.total_amount)) {
    await supabase.from("bookings").update({ payment_status: "paid" }).eq("id", booking.id);
  }

  return NextResponse.json({ data: payment, message: "Payment recorded" });
}
