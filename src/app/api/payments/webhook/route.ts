import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { provisionBookingAccess } from "@/lib/provision-booking-access";
import { getCachedSetting } from "@/lib/app-settings-cache";
import { enqueueTallyReceiptVoucher } from "@/lib/tally/enqueue";
import { isHandoffV2Enabled, handleStatementPaid } from "@/lib/tally-handoff-server";
import { handleRenewalPayment } from "@/lib/vo-renewal";
import { computeSettlement } from "@/lib/settlement";
import { finalizeBillingPayment } from "@/lib/billing-payment-settlement";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { logAudit, diffChanges } from "@/lib/audit";
import { istTodayYmd } from "@/lib/gst-invoice-number";

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

type ReceiptContext = Omit<Parameters<typeof logWebhookReceipt>[1], "outcome" | "outcome_detail">;

/**
 * A failed database write must not be acknowledged. Any 2xx tells Razorpay the
 * event was handled, so it never redelivers and the payment is lost silently.
 * Returning 500 makes Razorpay retry, and every write in this handler is safe
 * to repeat: payments are de-duplicated on razorpay_payment_id (unique index,
 * migration 00571) and status changes are conditional.
 */
function failForRetry(
  supabase: SupabaseClient,
  receipt: ReceiptContext,
  step: string,
  error: { message?: string } | null,
) {
  console.error(`[webhook] ${step} failed:`, error);
  logWebhookReceipt(supabase, { ...receipt, outcome: "error", outcome_detail: `${step}: ${error?.message ?? "unknown error"}` });
  return NextResponse.json({ error: `${step} failed` }, { status: 500 });
}

/** Postgres unique_violation — this Razorpay payment is already recorded. */
function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === "23505";
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

    const receipt: ReceiptContext = { event, razorpay_payment_id: paymentId, razorpay_order_id: orderId, entity: "booking" };

    // Find the booking_payment by razorpay_order_id
    const { data: bookingPayment, error: bookingPaymentErr } = await supabase
      .from("booking_payments")
      .select("id, booking_id, status")
      .eq("razorpay_order_id", orderId)
      .maybeSingle();
    if (bookingPaymentErr) return failForRetry(supabase, receipt, "Booking payment lookup", bookingPaymentErr);

    if (!bookingPayment) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: paymentId, razorpay_order_id: orderId, outcome: "ignored", outcome_detail: "No matching payment record" });
      return NextResponse.json({ status: "ignored", reason: "No matching payment record" });
    }

    // Flip pending → verified. The status filter makes the flip atomic: of two
    // concurrent deliveries, only one sees a row come back.
    let justVerified = false;
    if (bookingPayment.status === "pending") {
      const { data: verified, error: verifyErr } = await supabase
        .from("booking_payments")
        .update({
          status: "verified",
          razorpay_payment_id: paymentId,
          payment_reference: paymentId,
        })
        .eq("id", bookingPayment.id)
        .eq("status", "pending")
        .select("id");
      if (verifyErr) return failForRetry(supabase, receipt, "Booking payment verify", verifyErr);
      justVerified = (verified?.length ?? 0) > 0;
    }

    // Also runs on a redelivery of an already-verified payment, so a retry
    // after a failed write below still marks the booking paid.
    if (bookingPayment.status === "pending" || bookingPayment.status === "verified") {
      // Check if booking is now fully paid
      const { data: booking, error: bookingErr } = await supabase
        .from("bookings")
        .select("id, total_amount")
        .eq("id", bookingPayment.booking_id)
        .maybeSingle();
      if (bookingErr) return failForRetry(supabase, receipt, "Booking lookup", bookingErr);

      if (booking) {
        const { data: verifiedPayments, error: verifiedErr } = await supabase
          .from("booking_payments")
          .select("amount")
          .eq("booking_id", bookingPayment.booking_id)
          .eq("status", "verified");
        if (verifiedErr) return failForRetry(supabase, receipt, "Booking payments lookup", verifiedErr);

        const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

        if (totalPaid >= Number(booking.total_amount)) {
          const { data: markedPaid, error: bookingPaidErr } = await supabase
            .from("bookings")
            .update({ payment_status: "paid", payment_mode: "razorpay" })
            .eq("id", bookingPayment.booking_id)
            .or("payment_status.is.null,payment_status.neq.paid")
            .select("id");
          if (bookingPaidErr) return failForRetry(supabase, receipt, "Booking paid update", bookingPaidErr);

          // Provision COSEC access PIN now that booking is confirmed paid —
          // once, by whichever delivery verified the payment or paid the booking.
          // Called directly (no HTTP self-fetch) to avoid serverless network fragility.
          if (justVerified || (markedPaid?.length ?? 0) > 0) {
            provisionBookingAccess(bookingPayment.booking_id).catch((err) =>
              console.error("[webhook] COSEC provision failed:", err)
            );
          }
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
    const linkReceipt: ReceiptContext = { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId };
    // IST calendar date — a payment at 00:30 IST belongs to that day, not the
    // previous UTC day (which on the 1st is the previous GST period).
    const paymentDate = istTodayYmd();

    // Gap 2: Check if this payment link belongs to a prepaid purchase first
    const { data: purchase, error: purchaseErr } = await supabase
      .from("prepaid_purchases")
      .select("id, payment_status")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();
    if (purchaseErr) return failForRetry(supabase, linkReceipt, "Prepaid purchase lookup", purchaseErr);

    if (purchase && purchase.payment_status !== "paid") {
      const { error: purchaseUpdateErr } = await supabase
        .from("prepaid_purchases")
        .update({ payment_status: "paid", updated_at: new Date().toISOString() })
        .eq("id", purchase.id);
      if (purchaseUpdateErr) return failForRetry(supabase, { ...linkReceipt, entity: "prepaid_purchase" }, "Prepaid purchase update", purchaseUpdateErr);
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "prepaid_purchase", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "prepaid_purchase" });
    }

    // Check if this payment link belongs to a proposal (main payment)
    const { data: proposal, error: proposalErr } = await supabase
      .from("proposals")
      .select("id, proposal_number, lead_id, status, payment_status, payment_amount, payment_reference, payment_received_at")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();
    if (proposalErr) return failForRetry(supabase, linkReceipt, "Proposal lookup", proposalErr);

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
      const { error: proposalUpdateErr } = await supabase
        .from("proposals")
        .update(proposalUpdate)
        .eq("id", proposal.id);
      if (proposalUpdateErr) return failForRetry(supabase, { ...linkReceipt, entity: "proposal" }, "Proposal update", proposalUpdateErr);

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
    const { data: depositProposal, error: depositProposalErr } = await supabase
      .from("proposals")
      .select("id, proposal_number, status, deposit_payment_status, deposit_payment_amount, deposit_payment_reference, deposit_payment_received_at, deposit_payment_medium")
      .eq("deposit_razorpay_link_id", paymentLinkId)
      .maybeSingle();
    if (depositProposalErr) return failForRetry(supabase, linkReceipt, "Deposit proposal lookup", depositProposalErr);

    if (depositProposal && depositProposal.deposit_payment_status !== "paid") {
      const now = new Date().toISOString();
      /**
       * Record the money always; auto-accept only a proposal that is still
       * alive.
       *
       * A deposit link stays payable at Razorpay until someone cancels it,
       * and until this PR nothing could. So a link issued against a proposal
       * that was later rejected could still be paid — and this handler would
       * have flipped that rejected proposal to 'accepted', resurrecting a
       * dead deal on the strength of a stale link. One such proposal existed
       * with a live ₹33,000 link on it.
       *
       * The money is real either way and must be recorded. What must not
       * happen silently is the status change; a rejected proposal that
       * receives a deposit is something a human needs to look at.
       */
      const resurrects = depositProposal.status === "rejected" || depositProposal.status === "expired";
      if (resurrects) {
        console.warn(
          `[webhook] deposit paid on ${depositProposal.status} proposal ${depositProposal.proposal_number} — ` +
          `recording the payment but leaving its status alone`,
        );
      }
      // Mark deposit as paid, and auto-accept only if it isn't a dead deal.
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
        ...(resurrects ? {} : { status: "accepted", accepted_at: now }),
      };
      const { error: depositUpdateErr } = await supabase
        .from("proposals")
        .update(depositUpdate)
        .eq("id", depositProposal.id);
      if (depositUpdateErr) return failForRetry(supabase, { ...linkReceipt, entity: "proposal_deposit" }, "Deposit update", depositUpdateErr);

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
    const { data: topupResult, error: topupErr } = await supabase.rpc("mark_deposit_topup_paid", {
      p_razorpay_payment_link_id: paymentLinkId,
      p_razorpay_payment_id: razorpayPaymentId,
    });
    if (topupErr) return failForRetry(supabase, linkReceipt, "Deposit top-up update", topupErr);
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
    const { data: billingStatement, error: billingStatementErr } = await supabase
      .from("billing_statements")
      .select("id, total_amount, payment_status, voided_at")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();
    if (billingStatementErr) return failForRetry(supabase, linkReceipt, "Billing statement lookup", billingStatementErr);

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

    // Already settled — a redelivery (or a concurrent delivery that lost the
    // race). Acknowledge under the right entity instead of falling through to
    // the checks below, which would log it as "no matching entity".
    if (billingStatement?.payment_status === "paid") {
      logWebhookReceipt(supabase, { ...linkReceipt, entity: "billing_statement", outcome: "ignored", outcome_detail: "Statement already paid — duplicate webhook delivery" });
      return NextResponse.json({ status: "ok", entity: "billing_statement", reason: "Payment already recorded" });
    }

    if (billingStatement) {
      const receipt: ReceiptContext = { ...linkReceipt, entity: "billing_statement" };

      // Record payment — once per Razorpay payment. The lookup covers the
      // common redelivery; the unique index on razorpay_payment_id (00571)
      // catches two deliveries racing past it.
      let alreadyRecorded = false;
      if (razorpayPaymentId) {
        const { data: existingPayment, error: existingErr } = await supabase
          .from("billing_payments")
          .select("id")
          .eq("razorpay_payment_id", razorpayPaymentId)
          .limit(1);
        if (existingErr) return failForRetry(supabase, receipt, "Existing payment lookup", existingErr);
        alreadyRecorded = (existingPayment?.length ?? 0) > 0;
      }

      let insertedPayment: { id: string } | null = null;
      if (!alreadyRecorded) {
        const { data, error: insertErr } = await supabase
          .from("billing_payments")
          .insert({
            billing_statement_id: billingStatement.id,
            amount: amountPaid,
            payment_date: paymentDate,
            payment_mode: "razorpay",
            payment_reference: razorpayPaymentId || paymentLinkId,
            razorpay_payment_id: razorpayPaymentId,
          })
          .select("id")
          .single();
        if (insertErr && !isDuplicate(insertErr)) return failForRetry(supabase, receipt, "Payment insert", insertErr);
        insertedPayment = data;
      }

      // Handoff v2: when the flag is on, the legacy bridge-writer path and
      // the CRM-side GST auto-gen are both bypassed. The new flow routes the
      // statement to the accounts inbox via handoff_state instead. Legacy
      // path stays for v1 contracts and during the migration window.
      const v2Enabled = await isHandoffV2Enabled(supabase);

      if (!v2Enabled && insertedPayment) {
        // Reverse-sync to Tally as a receipt voucher (no-op unless this statement's
        // GST invoice was issued by Tally and sync is active). Fire-and-forget.
        void enqueueTallyReceiptVoucher(billingStatement.id, {
          paymentId: insertedPayment.id,
          amount: amountPaid,
          date: paymentDate,
          mode: "razorpay",
          reference: razorpayPaymentId || paymentLinkId,
        });
      }

      // Check if fully paid. TDS counts toward settlement (a prior manual
      // payment may carry a TDS deduction), and the statement settles on the
      // whole-rupee amount — same definition as the manual payment route.
      const { data: allPayments, error: allPaymentsErr } = await supabase
        .from("billing_payments")
        .select("amount, tds_amount")
        .eq("billing_statement_id", billingStatement.id);
      if (allPaymentsErr) return failForRetry(supabase, receipt, "Payments lookup", allPaymentsErr);

      const settlement = computeSettlement(billingStatement.total_amount, allPayments);
      // A payment just landed, so anything short of "paid" is "partially_paid".
      const newStatus = settlement.paymentStatus === "paid" ? "paid" : "partially_paid";

      // If this statement is a renewal pro-rata, mark the contract as paid.
      // Done before the statement flips to paid: once it is paid, a redelivery
      // is acknowledged above without reaching here, so this must not be the
      // write a retry depends on.
      if (newStatus === "paid") {
        const { error: prorataErr } = await supabase
          .from("contracts")
          .update({ prorata_payment_status: "paid" })
          .eq("prorata_billing_statement_id", billingStatement.id);
        if (prorataErr) return failForRetry(supabase, receipt, "Pro-rata contract update", prorataErr);
      }

      // Conditional on the status actually changing, so of two concurrent
      // deliveries only the one that moved the statement to "paid" fires the
      // GST invoice / handoff / VO renewal chain below.
      const { data: transitionedRows, error: statusErr } = await supabase
        .from("billing_statements")
        .update({ payment_status: newStatus })
        .eq("id", billingStatement.id)
        .or(`payment_status.is.null,payment_status.neq.${newStatus}`)
        .select("id");
      if (statusErr) return failForRetry(supabase, receipt, "Statement status update", statusErr);
      const becamePaid = newStatus === "paid" && (transitionedRows?.length ?? 0) > 0;

      if (becamePaid) {
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
      if (becamePaid) {
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

      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "billing_statement", outcome: "processed", outcome_detail: alreadyRecorded ? `${newStatus} (payment already recorded)` : newStatus });
      return NextResponse.json({ status: "ok", entity: "billing_statement" });
    }

    // Check if this payment link belongs to an ad-hoc lead invoice
    // (proforma_invoices). These links are created eagerly at invoice
    // creation time (POST /api/invoices) and paid directly by the customer —
    // unlike every other entity above, nothing else in the CRM ever recorded
    // this payment, so it silently fell through to "no matching entity"
    // below and the invoice stayed "sent" forever.
    const { data: adhocInvoice, error: adhocInvoiceErr } = await supabase
      .from("proforma_invoices")
      .select("id, invoice_number, status, title, items, subtotal, tax_percentage, tax_amount, total_amount, due_date, proposal_id")
      .eq("razorpay_link_id", paymentLinkId)
      .maybeSingle();
    if (adhocInvoiceErr) return failForRetry(supabase, linkReceipt, "Ad-hoc invoice lookup", adhocInvoiceErr);

    // A cancelled invoice's Razorpay link is best-effort cancelled at cancel
    // time, but a payment already in flight must not resurrect it — same
    // rationale as the voided billing_statement guard above.
    if (adhocInvoice?.status === "cancelled") {
      logWebhookReceipt(supabase, {
        event,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_payment_link_id: paymentLinkId,
        entity: "adhoc_invoice",
        outcome: "ignored",
        outcome_detail: `Invoice ${adhocInvoice.invoice_number} is cancelled — payment not recorded`,
      });
      return NextResponse.json({ status: "ok", entity: "adhoc_invoice", ignored: "cancelled" });
    }

    // Idempotency — a retried webhook delivery for an invoice already marked
    // paid. Return here with the right entity tag rather than falling
    // through to the booking check below, which would misreport it as "no
    // matching entity" in the log.
    if (adhocInvoice?.status === "paid") {
      logWebhookReceipt(supabase, {
        event,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_payment_link_id: paymentLinkId,
        entity: "adhoc_invoice",
        outcome: "ignored",
        outcome_detail: "Already paid — duplicate webhook delivery",
      });
      return NextResponse.json({ status: "ok", entity: "adhoc_invoice", reason: "Payment already recorded" });
    }

    if (adhocInvoice) {
      const receipt: ReceiptContext = { ...linkReceipt, entity: "adhoc_invoice" };
      // Find (or defensively create) the linked billing_statements row —
      // mirrors POST /api/invoices/[id]/payment (the manual "Record payment"
      // route) so both paths settle identically and land in the same Tally
      // Inbox flow. Normally this already exists (created when the invoice
      // was emailed), but the payment link is live from creation, so a
      // customer can in principle pay before the invoice was ever sent.
      const { data: existingStatement, error: adhocStatementErr } = await supabase
        .from("billing_statements")
        .select("id, total_amount, payment_status")
        .eq("invoice_id", adhocInvoice.id)
        .maybeSingle();
      if (adhocStatementErr) return failForRetry(supabase, receipt, "Ad-hoc statement lookup", adhocStatementErr);
      let statement = existingStatement;

      if (!statement) {
        const todayYmd = paymentDate;
        const lineItems = ((adhocInvoice.items || []) as Array<{ description: string; quantity: number; unit_price: number; total: number }>).map((item) => ({
          description: item.description,
          qty: item.quantity,
          unit_price: item.unit_price,
          amount: item.total,
          hsn_sac_code: resolveHsnCode("ad_hoc_charges"),
        }));
        const { data: newStatement, error: newStatementErr } = await supabase
          .from("billing_statements")
          .insert({
            invoice_id: adhocInvoice.id,
            contract_id: null,
            proposal_id: adhocInvoice.proposal_id ?? null,
            statement_type: "usage",
            created_via: "adhoc_invoice",
            status: "finalized",
            payment_status: "unpaid",
            handoff_state: "pi_awaiting_payment",
            period_start: todayYmd,
            period_end: todayYmd,
            subtotal: adhocInvoice.subtotal,
            fixed_amount: adhocInvoice.subtotal,
            tax_percentage: adhocInvoice.tax_percentage,
            tax_amount: adhocInvoice.tax_amount,
            total_amount: adhocInvoice.total_amount,
            due_date: (adhocInvoice.due_date as string | null) || todayYmd,
            line_items: [{ type: "usage", label: adhocInvoice.title, items: lineItems, subtotal: adhocInvoice.subtotal }],
          })
          .select("id, total_amount, payment_status")
          .single();
        if (newStatementErr) return failForRetry(supabase, receipt, "Ad-hoc statement insert", newStatementErr);
        statement = newStatement;
      }

      if (statement) {
        // Once per Razorpay payment, as in the billing_statement branch above.
        // On a retry after a failed write further down, the payment is
        // already there and settlement just re-runs.
        let alreadyRecorded = false;
        if (razorpayPaymentId) {
          const { data: existingPayment, error: existingErr } = await supabase
            .from("billing_payments")
            .select("id")
            .eq("razorpay_payment_id", razorpayPaymentId)
            .limit(1);
          if (existingErr) return failForRetry(supabase, receipt, "Existing payment lookup", existingErr);
          alreadyRecorded = (existingPayment?.length ?? 0) > 0;
        }

        let inserted = false;
        if (!alreadyRecorded) {
          const { error: insertErr } = await supabase.from("billing_payments").insert({
            billing_statement_id: statement.id,
            amount: amountPaid,
            payment_date: paymentDate,
            payment_mode: "razorpay",
            payment_reference: razorpayPaymentId || paymentLinkId,
            razorpay_payment_id: razorpayPaymentId,
          });
          if (insertErr && !isDuplicate(insertErr)) return failForRetry(supabase, receipt, "Payment insert", insertErr);
          inserted = !insertErr;
        }

        // Reverse-sync to Tally as a receipt voucher, same as the
        // billing_statement branch above — no-op unless this statement's
        // GST invoice was issued by Tally and sync is active.
        const v2Enabled = await isHandoffV2Enabled(supabase);
        if (!v2Enabled && inserted) {
          void enqueueTallyReceiptVoucher(statement.id, {
            paymentId: razorpayPaymentId || paymentLinkId,
            amount: amountPaid,
            date: paymentDate,
            mode: "razorpay",
            reference: razorpayPaymentId || paymentLinkId,
          });
        }

        // Shared settlement tail — persists payment_status and fires the
        // paid-transition chain (GST auto-gen / v2 handoff) identically to
        // every other payment-creation path.
        const settled = await finalizeBillingPayment(supabase, {
          statementId: statement.id,
          statementTotalAmount: statement.total_amount,
          previousPaymentStatus: statement.payment_status,
          reason: "razorpay_payment_link_paid",
        });
        if (settled.persistError) return failForRetry(supabase, receipt, "Ad-hoc settlement", { message: settled.persistError });
      }

      const now = new Date().toISOString();
      const invoiceUpdate = {
        status: "paid",
        paid_at: now,
        payment_reference: razorpayPaymentId || paymentLinkId,
      };
      const { error: invoiceUpdateErr } = await supabase.from("proforma_invoices").update(invoiceUpdate).eq("id", adhocInvoice.id);
      if (invoiceUpdateErr) return failForRetry(supabase, receipt, "Ad-hoc invoice update", invoiceUpdateErr);

      logAudit(supabase, {
        entityType: "invoice",
        entityId: adhocInvoice.id,
        action: "update",
        performedBy: "system",
        changes: diffChanges(adhocInvoice, invoiceUpdate),
      }).catch(() => {});

      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "adhoc_invoice", outcome: "processed" });
      return NextResponse.json({ status: "ok", entity: "adhoc_invoice" });
    }

    // Find the booking by razorpay_payment_link_id
    const { data: booking, error: linkBookingErr } = await supabase
      .from("bookings")
      .select("id, total_amount")
      .eq("razorpay_payment_link_id", paymentLinkId)
      .maybeSingle();
    if (linkBookingErr) return failForRetry(supabase, linkReceipt, "Booking lookup", linkBookingErr);
    const bookingReceipt: ReceiptContext = { ...linkReceipt, entity: "booking" };

    if (!booking) {
      logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, outcome: "ignored", outcome_detail: "No matching entity for payment link" });
      return NextResponse.json({ status: "ignored", reason: "No matching entity for payment link" });
    }

    // Check if we already recorded this payment (idempotency). A redelivery
    // still runs the paid check below, so a retry after a failed booking
    // update completes it.
    let bookingPaymentRecorded = false;
    if (razorpayPaymentId) {
      const { data: existing, error: existingErr } = await supabase
        .from("booking_payments")
        .select("id")
        .eq("razorpay_payment_id", razorpayPaymentId)
        .limit(1);
      if (existingErr) return failForRetry(supabase, bookingReceipt, "Existing booking payment lookup", existingErr);
      bookingPaymentRecorded = (existing?.length ?? 0) > 0;
    }

    // Create a verified payment record
    const { error: bookingInsertErr } = bookingPaymentRecorded ? { error: null } : await supabase
      .from("booking_payments")
      .insert({
        booking_id: booking.id,
        amount: amountPaid,
        payment_mode: "razorpay",
        status: "verified",
        razorpay_payment_id: razorpayPaymentId,
        payment_reference: razorpayPaymentId || paymentLinkId,
      });
    if (bookingInsertErr) return failForRetry(supabase, bookingReceipt, "Booking payment insert", bookingInsertErr);

    // Check if booking is now fully paid
    const { data: verifiedPayments, error: verifiedErr } = await supabase
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", booking.id)
      .eq("status", "verified");
    if (verifiedErr) return failForRetry(supabase, bookingReceipt, "Booking payments lookup", verifiedErr);

    const totalPaid = (verifiedPayments || []).reduce((sum, p) => sum + Number(p.amount), 0);

    if (totalPaid >= Number(booking.total_amount)) {
      const { error: bookingPaidErr } = await supabase
        .from("bookings")
        .update({ payment_status: "paid", payment_mode: "razorpay" })
        .eq("id", booking.id);
      if (bookingPaidErr) return failForRetry(supabase, bookingReceipt, "Booking paid update", bookingPaidErr);
    }

    logWebhookReceipt(supabase, { event, razorpay_payment_id: razorpayPaymentId, razorpay_payment_link_id: paymentLinkId, entity: "booking", outcome: "processed" });
    return NextResponse.json({ status: "ok" });
  }

  // Other events — acknowledge but don't process
  logWebhookReceipt(supabase, { event, outcome: "ignored", outcome_detail: "Unhandled event type" });
  return NextResponse.json({ status: "ok", event });
}
