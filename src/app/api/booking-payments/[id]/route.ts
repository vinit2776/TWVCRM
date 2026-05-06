import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// PATCH — verify or reject a payment (UPI screenshot verification)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const { status, verification_notes } = body;

  if (!status || !["verified", "rejected"].includes(status)) {
    return NextResponse.json({ error: "Status must be 'verified' or 'rejected'" }, { status: 400 });
  }

  // Fetch the payment
  const { data: payment } = await supabase
    .from("booking_payments")
    .select("*")
    .eq("id", id)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  if (payment.status !== "pending") {
    return NextResponse.json({ error: "Only pending payments can be verified/rejected" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    status,
    screenshot_verified: status === "verified",
    verification_notes: verification_notes?.trim() || null,
  };

  const { data: updated, error } = await supabase
    .from("booking_payments")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If verified, check if booking is now fully paid. Compare against the
  // GST-inclusive total — the displayed receipt amount — so a payment of
  // exactly the displayed total flips the booking to "paid".
  if (status === "verified") {
    const { data: booking } = await supabase
      .from("bookings")
      .select("id, total_amount, total_amount_with_gst")
      .eq("id", payment.booking_id)
      .single();

    if (booking) {
      const { data: verifiedPayments } = await supabase
        .from("booking_payments")
        .select("amount")
        .eq("booking_id", payment.booking_id)
        .eq("status", "verified");

      const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);
      const grandTotal = Number(booking.total_amount_with_gst || booking.total_amount);

      if (totalPaid >= grandTotal) {
        await supabase
          .from("bookings")
          .update({ payment_status: "paid", payment_mode: payment.payment_mode })
          .eq("id", payment.booking_id);
      }
    }
  }

  logAudit(supabase, {
    entityType: "booking_payment",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "pending", new: status },
      screenshot_verified: { old: null, new: status === "verified" },
    },
  });

  return NextResponse.json({ data: updated });
}
