import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { settleBookingPayment } from "@/lib/booking-payment-server";
import { canCancelReportedPayment, cancelNote } from "@/lib/booking-payment-rules";

// POST — cancel (withdraw) a reported manual UPI payment that is still pending.
// Stored as a rejection with a "Cancelled by …" note, so it leaves the balance,
// the To verify list and its report thread exactly like any rejected payment.
// Gone for good once the payment is verified: settle refuses non-pending rows.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    return NextResponse.json({ error: "Please give a reason for cancelling" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("booking_payments")
    .select("id, status, payment_mode, created_by")
    .eq("id", id)
    .maybeSingle();
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  if (payment.status !== "pending") {
    return NextResponse.json(
      { error: "This payment has already been verified or closed, so it can no longer be cancelled." },
      { status: 409 },
    );
  }
  if (!canCancelReportedPayment(payment, dbUser)) {
    return NextResponse.json(
      { error: "Only the person who reported this payment, or admin / accounts / manager, can cancel it." },
      { status: 403 },
    );
  }

  const result = await settleBookingPayment(admin, {
    paymentId: id,
    outcome: "rejected",
    notes: cancelNote(dbUser.full_name ?? "staff", reason),
    reviewer: dbUser as { id: string; role: string; full_name: string },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.payment });
}
