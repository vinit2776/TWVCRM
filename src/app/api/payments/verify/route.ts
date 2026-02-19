import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import crypto from "crypto";
import { logAudit } from "@/lib/audit";

// POST — verify Razorpay payment after checkout success
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_record_id } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !payment_record_id) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Fetch the key secret
  const { data: secretSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "razorpay_key_secret")
    .single();

  if (!secretSetting?.value) {
    return NextResponse.json({ error: "Razorpay key secret not configured" }, { status: 500 });
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac("sha256", secretSetting.value)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return NextResponse.json({ error: "Payment verification failed — invalid signature" }, { status: 400 });
  }

  // Update the payment record
  const { data: payment, error } = await supabase
    .from("booking_payments")
    .update({
      status: "verified",
      razorpay_payment_id,
      razorpay_signature,
      payment_reference: razorpay_payment_id,
    })
    .eq("id", payment_record_id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Check if booking is now fully paid
  if (payment) {
    const { data: booking } = await supabase
      .from("bookings")
      .select("id, total_amount")
      .eq("id", payment.booking_id)
      .single();

    if (booking) {
      const { data: verifiedPayments } = await supabase
        .from("booking_payments")
        .select("amount")
        .eq("booking_id", payment.booking_id)
        .eq("status", "verified");

      const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

      if (totalPaid >= Number(booking.total_amount)) {
        await supabase
          .from("bookings")
          .update({ payment_status: "paid", payment_mode: "razorpay" })
          .eq("id", payment.booking_id);
      }
    }

    logAudit(supabase, {
      entityType: "booking_payment",
      entityId: payment.id,
      action: "update",
      performedBy: dbUser.id,
      changes: { status: { old: "pending", new: "verified" } },
    });
  }

  return NextResponse.json({ data: payment, verified: true });
}
