import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  CORRECTABLE_PAYMENT_MODES,
  GST_INVOICE_LOCK_MESSAGE,
  PAYMENT_METHOD_EDIT_ROLES,
  isBookingPaymentMethodLocked,
} from "@/lib/booking-payment-method";

const bodySchema = z.object({
  payment_mode: z.enum(CORRECTABLE_PAYMENT_MODES),
  payment_reference: z.string().trim().max(255).optional().nullable(),
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

// PATCH — correct the payment method of a payment that was recorded wrongly.
// Allowed until accounts uploads the GST invoice for the booking.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { payment_mode: newMode, payment_reference, reason } = parsed.data;

  const admin = await createAdminClient();
  const { data: payment } = await admin
    .from("booking_payments")
    .select("id, booking_id, payment_mode, payment_reference, status, created_by, razorpay_payment_id, razorpay_order_id")
    .eq("id", id)
    .single();
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const canEdit =
    (PAYMENT_METHOD_EDIT_ROLES as readonly string[]).includes(dbUser.role) ||
    payment.created_by === dbUser.id;
  if (!canEdit) {
    return NextResponse.json({ error: "Only admin, accounts, manager or the person who recorded the payment can change its method" }, { status: 403 });
  }

  if (payment.status !== "verified") {
    return NextResponse.json({ error: "Only verified payments can have their method corrected" }, { status: 400 });
  }
  if (
    !(CORRECTABLE_PAYMENT_MODES as readonly string[]).includes(payment.payment_mode) ||
    payment.razorpay_payment_id || payment.razorpay_order_id
  ) {
    return NextResponse.json({ error: "Online (Razorpay) payments can't be edited" }, { status: 400 });
  }
  if (newMode === payment.payment_mode) {
    return NextResponse.json({ error: "Payment method is unchanged" }, { status: 400 });
  }

  if (await isBookingPaymentMethodLocked(admin, payment.booking_id)) {
    return NextResponse.json({ error: GST_INVOICE_LOCK_MESSAGE }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  // Cash carries a handover trail (who holds the money). Start one when a
  // payment becomes cash, clear it when it stops being cash.
  const updates: Record<string, unknown> =
    newMode === "cash"
      ? {
          payment_mode: newMode,
          cash_handover_status: "pending_handover",
          collected_by: dbUser.id,
          collected_at: nowIso,
          handed_over_to: null,
          handed_over_at: null,
          handover_confirmed_by: null,
          handover_confirmed_at: null,
          handover_notes: null,
        }
      : {
          payment_mode: newMode,
          cash_handover_status: null,
          collected_by: null,
          collected_at: null,
          handed_over_to: null,
          handed_over_at: null,
          handover_confirmed_by: null,
          handover_confirmed_at: null,
          handover_notes: null,
        };
  // Reference belongs to the method; a cash payment has none.
  updates.payment_reference = newMode === "cash" ? null : (payment_reference || null);

  const { data: updated, error } = await admin
    .from("booking_payments")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Keep the booking's displayed method in step with its latest verified payment.
  const { data: latest } = await admin
    .from("booking_payments")
    .select("payment_mode, payment_reference")
    .eq("booking_id", payment.booking_id)
    .eq("status", "verified")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: booking } = await admin
    .from("bookings")
    .select("payment_status")
    .eq("id", payment.booking_id)
    .single();
  if (latest && booking?.payment_status === "paid") {
    await admin
      .from("bookings")
      .update({ payment_mode: latest.payment_mode, payment_reference: latest.payment_reference ?? null })
      .eq("id", payment.booking_id);
  }

  // Awaited: on serverless the function can be frozen once the response is sent,
  // and this correction must always leave an audit trail.
  await logAudit(supabase, {
    entityType: "booking_payment",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_mode: { old: payment.payment_mode, new: newMode },
      payment_reference: { old: payment.payment_reference ?? null, new: updates.payment_reference },
      correction_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: updated });
}
