import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const PAYMENT_SELECT = "*, creator:users!booking_payments_created_by_fkey(id, full_name)";

// GET — list payments for a booking
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bookingId = request.nextUrl.searchParams.get("booking_id");
  if (!bookingId) {
    return NextResponse.json({ error: "booking_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("booking_payments")
    .select(PAYMENT_SELECT)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data || [] });
}

// POST — create a payment record
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
  const { booking_id, amount, payment_mode, payment_reference } = body;

  if (!booking_id || !amount || !payment_mode) {
    return NextResponse.json({ error: "booking_id, amount, and payment_mode are required" }, { status: 400 });
  }

  if (amount <= 0) {
    return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  }

  if (!["cash", "upi", "card", "razorpay"].includes(payment_mode)) {
    return NextResponse.json({ error: "Invalid payment mode" }, { status: 400 });
  }

  // Fetch the booking
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, total_amount, payment_status, customer_type")
    .eq("id", booking_id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Compute existing verified total
  const { data: existingPayments } = await supabase
    .from("booking_payments")
    .select("amount")
    .eq("booking_id", booking_id)
    .eq("status", "verified");

  const paidSoFar = (existingPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = Number(booking.total_amount) - paidSoFar;

  if (amount > balanceDue + 0.01) { // small epsilon for floating point
    return NextResponse.json({
      error: `Amount exceeds balance due. Balance: ₹${balanceDue.toFixed(2)}`,
      balance_due: balanceDue,
    }, { status: 400 });
  }

  // Determine initial status based on payment mode
  const status = (payment_mode === "cash" || payment_mode === "card") ? "verified" : "pending";

  // Build payment record with cash handover tracking
  const paymentRecord: Record<string, unknown> = {
    booking_id,
    amount,
    payment_mode,
    payment_reference: payment_reference?.trim() || null,
    status,
    created_by: dbUser.id,
  };

  // Cash handover tracking
  if (payment_mode === "cash") {
    paymentRecord.cash_handover_status = "pending_handover";
    paymentRecord.collected_by = dbUser.id;
    paymentRecord.collected_at = new Date().toISOString();
  }

  const { data: payment, error } = await supabase
    .from("booking_payments")
    .insert(paymentRecord)
    .select(PAYMENT_SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If this payment was auto-verified, check if booking is fully paid
  if (status === "verified") {
    const newTotal = paidSoFar + amount;
    if (newTotal >= Number(booking.total_amount)) {
      await supabase
        .from("bookings")
        .update({ payment_status: "paid", payment_mode })
        .eq("id", booking_id);
    }
  }

  logAudit(supabase, {
    entityType: "booking_payment",
    entityId: payment.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      amount: { old: null, new: amount },
      payment_mode: { old: null, new: payment_mode },
      status: { old: null, new: status },
    },
  });

  return NextResponse.json({ data: payment }, { status: 201 });
}
