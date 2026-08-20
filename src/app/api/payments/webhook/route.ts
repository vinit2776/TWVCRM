import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { provisionBookingAccess } from "@/lib/provision-booking-access";
import { getCachedSetting } from "@/lib/app-settings-cache";
import { enqueueTallyReceiptVoucher } from "@/lib/tally/enqueue";
import { isHandoffV2Enabled, handleStatementPaid } from "@/lib/tally-handoff-server";
import { handleRenewalPayment } from "@/lib/vo-renewal";
import { computeSettlement } from "@/lib/settlement";
import { logAudit, diffChanges } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Create a service-role Supabase client (no cookies/user session for webhooks)
function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Fire-and-forget receipt log — never blocks or throws.
function logWebhookReceipt(
  supabase: SupabaseClient,
  data: {
    event: string;
    razorpay_payment_id?: string | null;
    razorpay_order_id?: string | null;
    razorpay_payment_link_id?: string | null;
    entity?: string | null;
    outcome: "processed" | "ignored" | "error";
    outcome_detail?: string | null;
  }
) {
  supabase.from("razorpay_webhook_log").insert(data).then(
    () => {},
    (err) => console.error("[webhook-log] insert failed:", err)
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

  // Fetch webhook secret from settings (cached — avoids a DB round-trip on every webhook)
  const webhookSecret = await getCachedSetting(supabase, "razorpay_webhook_secret");

  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
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

  const event = payload.event as string;

  // Handle payment.captured event
  if (event === "payment.captured") {
    const paymentEntity = payload.payload?.payment?.entity;
    if (!paymentEntity) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const orderId = paymentEntity.order_id as string | undefined;
    const paymentId = paymentEntity.id as string;

    if (!orderId) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: paymentId, outcome: "ignored", outcome_detail: "No order_id in payment" });
      return NextResponse.json({ status: "ignored", reason: "No order_id in payment" });
    }

    // Find the booking_payment by razorpay_order_id
    const { data: bookingPayment } = await supabase
      .from("booking_payments")
      .select("id, booking_id, status")
      .eq("razorpay_order_id", orderId)
      .single();

    if (!bookingPayment) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: paymentId, razorpay_order_id: orderId, outcome: "ignored", outcome_detail: "No matching payment record" });
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

          // Provision COSEC access PIN now that booking is confirmed paid.
          // Called directly (no HTTP self-fetch) to avoid serverless network fragility.
          provisionBookingAccess(bookingPayment.booking_id).catch((err) =>
            console.error("[webhook] COSEC provision failed:", err)
          );
        }
      }
    }

    logWebhookReceipt(supabase, { event, razorpay_payment_id: paymentId, razorpay_order_id: orderId, entity: "booking", outcome: "processed" });
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
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "prepaid_purchase", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "prepaid_purchase" });
    }

    // Check if this payment link belongs to a proposal (main payment)
    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, proposal_number, lead_id, status, payment_status, payment_amount, payment_reference, payment_received_at")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();

    if (proposal && proposal.payment_status !== "paid") {
      const now = new Date().toISOString();
      const proposalUpdate = {
        payment_status: "paid",
        status: "accepted",
        accepted_at: now,
        payment_received_at: now,
        payment_amount: amountPaid,
        payment_reference: razorpayPaymentId || paymentLinkId,
      };
      await supabase
        .from("proposals")
        .update(proposalUpdate)
        .eq("id", proposal.id);

      logAudit(supabase, {
        entityType: "proposal",
        entityId: proposal.id,
        action: "update",
        performedBy: "system",
        changes: diffChanges(proposal, proposalUpdate),
      }).catch(() => {});

      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "proposal", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "proposal" });
    }

    // Check if this payment link belongs to a proposal security deposit
    const { data: depositProposal } = await supabase
      .from("proposals")
      .select("id, proposal_number, status, deposit_payment_status, deposit_payment_amount, deposit_payment_reference, deposit_payment_received_at, deposit_payment_medium")
      .eq("deposit_razorpay_link_id", paymentLinkId)
      .maybeSingle();

    if (depositProposal && depositProposal.deposit_payment_status !== "paid") {
      const now = new Date().toISOString();
      // Mark deposit as paid AND auto-accept the proposal
      const depositUpdate = {
        deposit_payment_status: "paid",
        deposit_payment_received_at: now,
        deposit_payment_amount: amountPaid,
        deposit_payment_reference: razorpayPaymentId || paymentLinkId,
        // Stamped here because the Tally Inbox shows this column to tell
        // accounts how the money arrived. Omitting it left every
        // link-paid deposit in the inbox with a blank medium, while
        // manually recorded ones (which set it in
        // /api/proposals/[id]/deposit-payment) read correctly — so the
        // cleanest path produced the least legible inbox row.
        deposit_payment_medium: "razorpay",
        status: "accepted",
        accepted_at: now,
      };
      await supabase
        .from("proposals")
        .update(depositUpdate)
        .eq("id", depositProposal.id);

      logAudit(supabase, {
        entityType: "proposal",
        entityId: depositProposal.id,
        action: "update",
        performedBy: "system",
        changes: diffChanges(depositProposal, depositUpdate),
      }).catch(() => {});

      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "proposal_deposit", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "proposal_deposit" });
    }

    // Check if this payment link belongs to a contract deposit top-up.
    // mark_deposit_topup_paid is idempotent (only acts on status='pending'),
    // and also handles the atomic deposit_shortfall decrement if this
    // top-up was collecting a renewal-escalation shortfall.
    const { data: topupResult } = await supabase.rpc("mark_deposit_topup_paid", {
      p_razorpay_payment_link_id: paymentLinkId,
      p_razorpay_payment_id: razorpayPaymentId,
    });
    const topupOutcome = topupResult?.[0];
    if (topupOutcome?.success) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "deposit_topup", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "deposit_topup" });
    }
    if (topupOutcome?.topup_id) {
      // Matched a top-up row but it wasn't 'pending' — a duplicate webhook
      // delivery for an already-processed top-up. Acknowledge, don't fall
      // through to the other entity checks below (none of them will match).
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "deposit_topup", outcome: "ignored", outcome_detail: topupOutcome.error });
      return NextResponse.json({ status: "ok", entity: "deposit_topup", reason: topupOutcome.error });
    }

    // Check if this payment link belongs to a billing statement (invoice)
    const { data: billingStatement } = await supabase
      .from("billing_statements")
      .select("id, total_amount, payment_status, voided_at")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();

    // A voided statement is no longer a receivable. Its Razorpay link is
    // cancelled at void time, but a payment already in flight (or a link the
    // cancel call failed on) must not be booked against a cancelled invoice —
    // that would resurrect it in AR and mis-state the month. Record the receipt
    // for reconciliation and let accounts handle it as an unallocated payment.
    if (billingStatement?.voided_at) {
      logWebhookReceipt(supabase, {
        event,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_payment_link_id: paymentLinkId,
        entity: "billing_statement",
        outcome: "ignored",
        outcome_detail: `Statement ${billingStatement.id} is voided — payment not recorded`,
      });
      return NextResponse.json({ status: "ok", entity: "billing_statement", ignored: "voided" });
    }

    if (billingStatement && billingStatement.payment_status !== "paid") {
      // Record payment
      const { data: insertedPayment } = await supabase
        .from("billing_payments")
        .insert({
          billing_statement_id: billingStatement.id,
          amount: amountPaid,
          payment_date: new Date().toISOString().slice(0, 10),
          payment_mode: "razorpay",
          payment_reference: razorpayPaymentId || paymentLinkId,
          razorpay_payment_id: razorpayPaymentId,
        })
        .select("id")
        .single();

      // Handoff v2: when the flag is on, the legacy bridge-writer path and
      // the CRM-side GST auto-gen are both bypassed. The new flow routes the
      // statement to the accounts inbox via handoff_state instead. Legacy
      // path stays for v1 contracts and during the migration window.
      const v2Enabled = await isHandoffV2Enabled(supabase);

      if (!v2Enabled) {
        // Reverse-sync to Tally as a receipt voucher (no-op unless this statement's
        // GST invoice was issued by Tally and sync is active). Fire-and-forget.
        void enqueueTallyReceiptVoucher(billingStatement.id, {
          paymentId: insertedPayment?.id || (razorpayPaymentId as string) || paymentLinkId,
          amount: amountPaid,
          date: new Date().toISOString().slice(0, 10),
          mode: "razorpay",
          reference: razorpayPaymentId || paymentLinkId,
        });
      }

      // Check if fully paid. TDS counts toward settlement (a prior manual
      // payment may carry a TDS deduction), and the statement settles on the
      // whole-rupee amount — same definition as the manual payment route.
      const { data: allPayments } = await supabase
        .from("billing_payments")
        .select("amount, tds_amount")
        .eq("billing_statement_id", billingStatement.id);

      const settlement = computeSettlement(billingStatement.total_amount, allPayments);
      // A payment just landed, so anything short of "paid" is "partially_paid".
      const newStatus = settlement.paymentStatus === "paid" ? "paid" : "partially_paid";

      await supabase
        .from("billing_statements")
        .update({ payment_status: newStatus })
        .eq("id", billingStatement.id);

      if (newStatus === "paid") {
        if (v2Enabled) {
          // v2: set handoff_state based on billing_mode. Accounts handles the
          // GST issuance / receipt recording from the inbox. No CRM-side gen,
          // no bridge writer.
          await handleStatementPaid(supabase, billingStatement.id, "razorpay_payment_link_paid");
        } else {
          // Legacy: auto-generate GST invoice when fully paid online.
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
      }

      // If this billing statement is linked to a VO case, complete the renewal
      if (newStatus === "paid") {
        const { data: stmtFull } = await supabase
          .from("billing_statements")
          .select("case_id, statement_type")
          .eq("id", billingStatement.id)
          .single();

        if (stmtFull?.case_id && stmtFull.statement_type === "vo_renewal") {
          void handleRenewalPayment({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          adminSupabase: supabase as unknown as any,
            caseId: stmtFull.case_id,
            statementId: billingStatement.id,
            amountPaid,
            razorpayPaymentId: razorpayPaymentId || "",
            razorpayLinkId: paymentLinkId,
          }).catch((err) => console.error("[webhook] VO renewal completion failed:", err));
        }
      }

      // If this statement is a renewal pro-rata, mark the contract as paid
      if (newStatus === "paid") {
        const { data: prorataContract } = await supabase
          .from("contracts")
          .select("id")
          .eq("prorata_billing_statement_id", billingStatement.id)
          .maybeSingle();
        if (prorataContract) {
          await supabase
            .from("contracts")
            .update({ prorata_payment_status: "paid" })
            .eq("id", prorataContract.id);
        }
      }

      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "billing_statement", outcome: "processed", outcome_detail: newStatus });
      return NextResponse.json({ status: "ok", entity: "billing_statement" });
    }

    // Find the booking by razorpay_payment_link_id
    const { data: booking } = await supabase
      .from("bookings")
      .select("id, total_amount")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .single();

    if (!booking) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, outcome: "ignored", outcome_detail: "No matching entity for payment link" });
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

    logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "booking", outcome: "processed" });
    return NextResponse.json({ status: "ok" });
  }

  // Other events — acknowledge but don't process
  logWebhookReceipt(supabase, { event, outcome: "ignored", outcome_detail: "Unhandled event type" });
  return NextResponse.json({ status: "ok", event });
}
