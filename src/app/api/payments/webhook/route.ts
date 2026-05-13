import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const dynamic = "force-dynamic";

// Create a service-role Supabase client (no cookies/user session for webhooks)
function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// POST — Razorpay webhook handler
export async function POST(request: NextRequest) {
  const supabase = createServiceClient();

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Fetch webhook secret from settings
  const { data: secretSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "razorpay_webhook_secret")
    .single();

  if (!secretSetting?.value) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac("sha256", secretSetting.value)
    .update(rawBody)
    .digest("hex");

  if (expectedSignature !== signature) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = payload.event;

  // Handle payment.captured event
  if (event === "payment.captured") {
    const paymentEntity = payload.payload?.payment?.entity;
    if (!paymentEntity) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const orderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;

    if (!orderId) {
      return NextResponse.json({ status: "ignored", reason: "No order_id in payment" });
    }

    // Find the booking_payment by razorpay_order_id
    const { data: bookingPayment } = await supabase
      .from("booking_payments")
      .select("id, booking_id, status")
      .eq("razorpay_order_id", orderId)
      .single();

    if (!bookingPayment) {
      return NextResponse.json({ status: "ignored", reason: "No matching payment record" });
    }

    // Only update if still pending
    if (bookingPayment.status === "pending") {
      await supabase
        .from("booking_payments")
        .update({
          status: "verified",
          razorpay_payment_id: paymentId,
          payment_reference: paymentId,
        })
        .eq("id", bookingPayment.id);

      // Check if booking is now fully paid
      const { data: booking } = await supabase
        .from("bookings")
        .select("id, total_amount")
        .eq("id", bookingPayment.booking_id)
        .single();

      if (booking) {
        const { data: verifiedPayments } = await supabase
          .from("booking_payments")
          .select("amount")
          .eq("booking_id", bookingPayment.booking_id)
          .eq("status", "verified");

        const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

        if (totalPaid >= Number(booking.total_amount)) {
          await supabase
            .from("bookings")
            .update({ payment_status: "paid", payment_mode: "razorpay" })
            .eq("id", bookingPayment.booking_id);
        }
      }
    }

    return NextResponse.json({ status: "ok" });
  }

  // Handle payment_link.paid event (Razorpay Payment Links)
  if (event === "payment_link.paid") {
    const paymentLinkEntity = payload.payload?.payment_link?.entity;
    const paymentEntity = payload.payload?.payment?.entity;

    if (!paymentLinkEntity) {
      return NextResponse.json({ error: "Invalid payment_link payload" }, { status: 400 });
    }

    const paymentLinkId = paymentLinkEntity.id;
    const amountPaid = paymentLinkEntity.amount_paid
      ? paymentLinkEntity.amount_paid / 100
      : paymentEntity?.amount
        ? paymentEntity.amount / 100
        : 0;
    const razorpayPaymentId = paymentEntity?.id || null;

    // Gap 2: Check if this payment link belongs to a prepaid purchase first
    const { data: purchase } = await supabase
      .from("prepaid_purchases")
      .select("id, payment_status")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();

    if (purchase && purchase.payment_status !== "paid") {
      await supabase
        .from("prepaid_purchases")
        .update({ payment_status: "paid", updated_at: new Date().toISOString() })
        .eq("id", purchase.id);
      return NextResponse.json({ status: "ok", entity: "prepaid_purchase" });
    }

    // Check if this payment link belongs to a proposal (main payment)
    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, proposal_number, lead_id, payment_status")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();

    if (proposal && proposal.payment_status !== "paid") {
      const now = new Date().toISOString();
      await supabase
        .from("proposals")
        .update({
          payment_status: "paid",
          status: "accepted",
          accepted_at: now,
          payment_received_at: now,
          payment_amount: amountPaid,
          payment_reference: razorpayPaymentId || paymentLinkId,
        })
        .eq("id", proposal.id);

      return NextResponse.json({ status: "ok", entity: "proposal" });
    }

    // Check if this payment link belongs to a proposal security deposit
    const { data: depositProposal } = await supabase
      .from("proposals")
      .select("id, proposal_number, deposit_payment_status")
      .eq("deposit_razorpay_link_id", paymentLinkId)
      .maybeSingle();

    if (depositProposal && depositProposal.deposit_payment_status !== "paid") {
      const now = new Date().toISOString();
      // Mark deposit as paid AND auto-accept the proposal
      await supabase
        .from("proposals")
        .update({
          deposit_payment_status: "paid",
          deposit_payment_received_at: now,
          deposit_payment_amount: amountPaid,
          deposit_payment_reference: razorpayPaymentId || paymentLinkId,
          status: "accepted",
          accepted_at: now,
        })
        .eq("id", depositProposal.id);

      return NextResponse.json({ status: "ok", entity: "proposal_deposit" });
    }

    // Check if this payment link belongs to a billing statement (invoice)
    const { data: billingStatement } = await supabase
      .from("billing_statements")
      .select("id, total_amount, payment_status")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();

    if (billingStatement && billingStatement.payment_status !== "paid") {
      // Record payment
      await supabase
        .from("billing_payments")
        .insert({
          billing_statement_id: billingStatement.id,
          amount: amountPaid,
          payment_date: new Date().toISOString().slice(0, 10),
          payment_mode: "razorpay",
          payment_reference: razorpayPaymentId || paymentLinkId,
          razorpay_payment_id: razorpayPaymentId,
        });

      // Check if fully paid
      const { data: allPayments } = await supabase
        .from("billing_payments")
        .select("amount")
        .eq("billing_statement_id", billingStatement.id);

      const totalPaid = (allPayments || []).reduce((s: number, p: { amount: number }) => s + Number(p.amount), 0);
      const newStatus = totalPaid >= Number(billingStatement.total_amount) ? "paid" : "partially_paid";

      await supabase
        .from("billing_statements")
        .update({ payment_status: newStatus })
        .eq("id", billingStatement.id);

      // Auto-generate GST invoice when fully paid online
      if (newStatus === "paid") {
        try {
          const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
          fetch(`${appUrl}/api/billing-statements/${billingStatement.id}/generate-gst-invoice`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": process.env.CRON_SECRET || "",
            },
            body: JSON.stringify({ skipAuth: true }),
          }).catch((err) => console.error("[webhook] GST invoice generation failed:", err));
        } catch (err) {
          console.error("[webhook] Could not trigger GST invoice generation:", err);
        }
      }

      return NextResponse.json({ status: "ok", entity: "billing_statement" });
    }

    // Find the booking by razorpay_payment_link_id
    const { data: booking } = await supabase
      .from("bookings")
      .select("id, total_amount")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .single();

    if (!booking) {
      return NextResponse.json({ status: "ignored", reason: "No matching entity for payment link" });
    }

    // Check if we already recorded this payment (idempotency)
    if (razorpayPaymentId) {
      const { data: existing } = await supabase
        .from("booking_payments")
        .select("id")
        .eq("razorpay_payment_id", razorpayPaymentId)
        .maybeSingle();

      if (existing) {
        return NextResponse.json({ status: "ok", reason: "Payment already recorded" });
      }
    }

    // Create a verified payment record
    await supabase
      .from("booking_payments")
      .insert({
        booking_id: booking.id,
        amount: amountPaid,
        payment_mode: "razorpay",
        status: "verified",
        razorpay_payment_id: razorpayPaymentId,
        payment_reference: razorpayPaymentId || paymentLinkId,
      });

    // Check if booking is now fully paid
    const { data: verifiedPayments } = await supabase
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", booking.id)
      .eq("status", "verified");

    const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

    if (totalPaid >= Number(booking.total_amount)) {
      await supabase
        .from("bookings")
        .update({ payment_status: "paid", payment_mode: "razorpay" })
        .eq("id", booking.id);
    }

    return NextResponse.json({ status: "ok" });
  }

  // Other events — acknowledge but don't process
  return NextResponse.json({ status: "ok", event });
}
