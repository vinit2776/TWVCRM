import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const PAYMENT_SELECT = "*, creator:users!booking_payments_created_by_fkey(id, full_name), collector:users!booking_payments_collected_by_fkey(id, full_name), handover_receiver:users!booking_payments_handed_over_to_fkey(id, full_name), handover_confirmer:users!booking_payments_handover_confirmed_by_fkey(id, full_name)";

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

  // verify_on_create: when staff records a UPI/manual-QR payment WITH proof
  // attached at the counter, the upload itself is the operator's attestation.
  // We trust staff roles and skip the separate verification step so check-in
  // can proceed immediately. Restricted to roles that can run the floor.
  const verifyOnCreate = body.verify_on_create === true && [
    "admin", "manager", "floor_manager", "fms", "office_admin",
  ].includes(dbUser.role);

  if (!booking_id || !amount || !payment_mode) {
    return NextResponse.json({ error: "booking_id, amount, and payment_mode are required" }, { status: 400 });
  }

  if (amount <= 0) {
    return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  }

  if (!["cash", "upi", "card", "razorpay"].includes(payment_mode)) {
    return NextResponse.json({ error: "Invalid payment mode" }, { status: 400 });
  }

  // Determine initial status:
  //   • cash / card  → verified (cash physically collected; card already cleared)
  //   • upi          → pending UNLESS verify_on_create is set (staff attesting via uploaded proof)
  //   • razorpay     → pending (webhook flips to verified asynchronously)
  const status = (payment_mode === "cash" || payment_mode === "card")
    ? "verified"
    : (payment_mode === "upi" && verifyOnCreate)
      ? "verified"
      : "pending";

  // Atomic RPC: locks the booking row, verifies balance, and inserts the
  // payment in one transaction — prevents the race where two concurrent
  // submissions both read the same paidSoFar and both pass the balance check.
  const { data: rpcResult, error: rpcError } = await supabase.rpc("insert_booking_payment_atomic", {
    p_booking_id: booking_id,
    p_amount: amount,
    p_payment_mode: payment_mode,
    p_payment_reference: payment_reference?.trim() || null,
    p_status: status,
    p_created_by: dbUser.id,
    p_cash_handover_status: payment_mode === "cash" ? "pending_handover" : null,
    p_collected_by: payment_mode === "cash" ? dbUser.id : null,
    p_collected_at: payment_mode === "cash" ? new Date().toISOString() : null,
    p_screenshot_verified: (payment_mode === "upi" && verifyOnCreate) ? true : null,
    p_verification_notes: (payment_mode === "upi" && verifyOnCreate)
      ? `Verified at counter by ${dbUser.id} against uploaded payment confirmation`
      : null,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  // RPC returns a JSONB object; check for balance error
  if (rpcResult?.error) {
    return NextResponse.json({
      error: rpcResult.error,
      balance_due: rpcResult.balance_due,
    }, { status: 400 });
  }

  // Re-fetch the payment with all joined relations for the response
  const { data: payment, error } = await supabase
    .from("booking_payments")
    .select(PAYMENT_SELECT)
    .eq("id", rpcResult.payment.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If this payment was auto-verified, check if booking is fully paid
  if (status === "verified") {
    const newTotal = Number(rpcResult.new_total);
    const grandTotal = Number(rpcResult.grand_total);
    if (newTotal >= grandTotal) {
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
