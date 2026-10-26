/**
 * booking-payment-server.ts — SERVER-ONLY
 *
 * The two server steps a manual UPI booking payment goes through:
 *
 *   raiseBookingPaymentReport — when staff record a UPI payment that nobody
 *     verified at the counter, open a `payment_reported` thread so it appears
 *     in the Tally Inbox "To verify" tab and on /queries. Without it the row
 *     sat as booking_payments.status = 'pending' with nobody told.
 *
 *   settleBookingPayment — verify or reject that payment. One function for
 *     both entry points (the booking page, and the To verify card), so the
 *     over-credit guard, the booking → paid flip, the GST task and the report
 *     thread can't drift apart.
 *
 * Neither throws for the report side: a failed thread must never lose or block
 * a payment the customer has already made.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { maybeCreateBookingGstTask } from "@/lib/booking-gst-task";
import { queryEntityDef, type EntityRow } from "@/lib/queries/registry";
import { fanOutQueryEvent, entityLabel } from "@/lib/queries/server";
import {
  PAYMENT_REPORT_AUDIENCE_ROLES,
  defaultNeededBy,
} from "@/lib/queries/payment-reports";
import { verifyExcess } from "@/lib/booking-payment-rules";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";

interface Actor {
  id: string;
  role: string;
  full_name: string;
}

interface PaymentRow {
  id: string;
  booking_id: string;
  amount: number | string;
  payment_mode: string;
  payment_reference: string | null;
  status: string;
}

/** Today's date in IST as YYYY-MM-DD, the "paid on" a counter report means. */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export async function raiseBookingPaymentReport(
  admin: SupabaseClient,
  args: { payment: PaymentRow; author: Actor; body?: string; headline?: string },
): Promise<void> {
  const { payment, author } = args;
  try {
    const def = queryEntityDef("booking");
    if (!def) return;

    const { data: entityRow } = await admin
      .from(def.table)
      .select(def.select)
      .eq("id", payment.booking_id)
      .maybeSingle();
    if (!entityRow) return;

    const amount = Number(payment.amount);
    const modeLabel = STATEMENT_PAYMENT_MODE_LABELS[payment.payment_mode] ?? payment.payment_mode.toUpperCase();
    const summary = [
      `₹${amount.toLocaleString("en-IN")}`,
      modeLabel,
      payment.payment_reference ? `ref ${payment.payment_reference}` : null,
    ].filter(Boolean).join(" · ");

    const body = args.body ?? [
      `Walk-in booking payment recorded at the counter — ${summary}.`,
      "The customer has been told it's paid. Check it against the bank credit, then verify here or from the booking.",
    ].join("\n\n");

    const targeting = {
      audience: "roles" as const,
      audience_roles: [...PAYMENT_REPORT_AUDIENCE_ROLES],
      audience_user_ids: [] as string[],
    };

    const { data: thread, error: threadErr } = await admin
      .from("queries")
      .insert({
        entity_type: def.type,
        entity_id: payment.booking_id,
        kind: "payment_reported",
        created_by: author.id,
        needed_by: defaultNeededBy(new Date()),
        audience: targeting.audience,
        audience_roles: targeting.audience_roles,
        audience_user_ids: targeting.audience_user_ids,
      })
      .select("id")
      .single();
    if (threadErr || !thread) {
      console.error("[booking-payment-report] thread insert failed:", threadErr?.message);
      return;
    }

    const { error: msgErr } = await admin.from("query_messages").insert({
      query_id: thread.id,
      event_type: "message",
      body,
      created_by: author.id,
    });

    const { data: report, error: reportErr } = await admin
      .from("query_payment_reports")
      .insert({
        query_id: thread.id,
        amount,
        paid_on: istToday(),
        payment_mode: payment.payment_mode,
        payment_reference: payment.payment_reference,
        target_kind: "booking",
        booking_payment_id: payment.id,
        created_by: author.id,
      })
      .select("id")
      .single();

    if (msgErr || reportErr || !report) {
      // A thread with no structured row is the unreconcilable prose this
      // feature replaces, so don't leave one behind.
      console.error("[booking-payment-report] report insert failed:", msgErr?.message ?? reportErr?.message);
      await admin.from("queries").delete().eq("id", thread.id);
      return;
    }

    const entitySummary = def.toSummary(entityRow as unknown as EntityRow);

    await fanOutQueryEvent(admin, {
      queryId: thread.id,
      def,
      targeting,
      entitySummary,
      entityId: payment.booking_id,
      author,
      participantIds: [author.id],
      headline: args.headline ?? "Booking payment reported — needs verification",
      message: body,
      notificationType: "payment_reported",
    });

    void logAudit(admin, {
      entityType: def.auditEntityType,
      entityId: payment.booking_id,
      action: "payment_reported",
      performedBy: author.id,
      changes: {
        query_id: { old: null, new: thread.id },
        payment_report_id: { old: null, new: report.id },
        reported_payment: { old: null, new: summary },
        context: { old: null, new: entityLabel(def, entitySummary) },
      },
    });
  } catch (err) {
    console.error("[booking-payment-report] unexpected error:", err);
  }
}

export type SettleResult =
  | { ok: true; payment: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * Verify or reject a pending booking payment.
 *
 * `settleReport` is false when the caller is the To verify route, which closes
 * the report and thread itself with its own timeline, notification and audit.
 */
export async function settleBookingPayment(
  admin: SupabaseClient,
  args: {
    paymentId: string;
    outcome: "verified" | "rejected";
    notes: string | null;
    reviewer: Actor;
    settleReport?: boolean;
  },
): Promise<SettleResult> {
  const { paymentId, outcome, notes, reviewer } = args;
  const settleReport = args.settleReport ?? true;

  const { data: payment } = await admin
    .from("booking_payments")
    .select("id, booking_id, amount, payment_mode, status")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment) return { ok: false, status: 404, error: "Payment not found" };
  if (payment.status !== "pending") {
    return { ok: false, status: 400, error: "Only pending payments can be verified/rejected" };
  }

  const { data: booking } = await admin
    .from("bookings")
    .select("id, total_amount, total_amount_with_gst")
    .eq("id", payment.booking_id)
    .single();
  const grandTotal = booking ? Number(booking.total_amount_with_gst || booking.total_amount) : 0;

  if (outcome === "verified" && booking) {
    const { data: verifiedRows } = await admin
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", payment.booking_id)
      .eq("status", "verified");
    const verifiedTotal = (verifiedRows || []).reduce((s, p) => s + Number(p.amount), 0);

    // The customer can pay twice, or staff can record the same UPI twice. A
    // second verified row would double-count revenue and GST, so refuse and
    // point at the way out: close this one as a duplicate and refund.
    const excess = verifyExcess(grandTotal, verifiedTotal, Number(payment.amount));
    if (excess > 0) {
      return {
        ok: false,
        status: 409,
        error: `Verifying this would take the booking ₹${excess.toLocaleString("en-IN")} over its total — it is already paid in full. If the customer paid twice, reject this one as a duplicate and raise a refund.`,
      };
    }
  }

  const { data: updated, error } = await admin
    .from("booking_payments")
    .update({
      status: outcome,
      screenshot_verified: outcome === "verified",
      verification_notes: notes?.trim() || null,
    })
    .eq("id", paymentId)
    // Two people pressing Verify must not both succeed.
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!updated) return { ok: false, status: 409, error: "This payment was just settled by someone else" };

  if (outcome === "verified" && booking) {
    const { data: verifiedNow } = await admin
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", payment.booking_id)
      .eq("status", "verified");
    const totalPaid = (verifiedNow || []).reduce((s, p) => s + Number(p.amount), 0);

    if (totalPaid >= grandTotal) {
      await admin
        .from("bookings")
        .update({ payment_status: "paid", payment_mode: payment.payment_mode })
        .eq("id", payment.booking_id);
      // Safe even if the booking isn't checked out yet: the helper checks
      // status itself, and checkout calls it again.
      await maybeCreateBookingGstTask(admin, payment.booking_id as string);
    }
  }

  if (settleReport) {
    await settleReportForPayment(admin, { paymentId, outcome, notes, reviewer });
  }

  void logAudit(admin, {
    entityType: "booking_payment",
    entityId: paymentId,
    action: "update",
    performedBy: reviewer.id,
    changes: {
      status: { old: "pending", new: outcome },
      screenshot_verified: { old: null, new: outcome === "verified" },
    },
  });

  return { ok: true, payment: updated as Record<string, unknown> };
}

/** Close the open report (and its thread) that points at this payment. */
async function settleReportForPayment(
  admin: SupabaseClient,
  args: { paymentId: string; outcome: "verified" | "rejected"; notes: string | null; reviewer: Actor },
): Promise<void> {
  try {
    const { data: report } = await admin
      .from("query_payment_reports")
      .select("id, query_id")
      .eq("booking_payment_id", args.paymentId)
      .eq("status", "reported")
      .maybeSingle();
    if (!report) return;

    const now = new Date().toISOString();
    const note =
      args.notes?.trim() ||
      (args.outcome === "verified"
        ? "Found in the bank and verified against the booking."
        : "Closed from the booking — no such payment.");

    // The rejected constraint demands a reason; fall back to the same text.
    await admin
      .from("query_payment_reports")
      .update({
        status: args.outcome,
        resolution_note: note,
        reviewed_by: args.reviewer.id,
        reviewed_at: now,
      })
      .eq("id", report.id)
      .eq("status", "reported");

    await admin.from("query_messages").insert({
      query_id: report.query_id,
      event_type: args.outcome === "verified" ? "payment_verified" : "payment_rejected",
      body: note,
      created_by: args.reviewer.id,
    });

    await admin
      .from("queries")
      .update({ status: "resolved", resolved_by: args.reviewer.id, resolved_at: now, escalated_at: null })
      .eq("id", report.query_id);
  } catch (err) {
    console.error("[booking-payment-report] settle report failed:", err);
  }
}

/**
 * A walk-in checked in on a UPI payment accounts hadn't verified yet. Leave a
 * trail in both places someone would look: the report thread accounts are
 * working from, and the booking's audit history. Never throws.
 */
export async function noteProvisionalCheckIn(
  admin: SupabaseClient,
  args: { bookingId: string; bookingNumber: string; actor: Actor },
): Promise<void> {
  try {
    const { data: thread } = await admin
      .from("queries")
      .select("id")
      .eq("entity_type", "booking")
      .eq("entity_id", args.bookingId)
      .eq("kind", "payment_reported")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (thread) {
      await admin.from("query_messages").insert({
        query_id: thread.id,
        event_type: "message",
        body: `${args.actor.full_name} checked the customer in before this payment was verified. If the credit isn't in the bank, the customer is already on the premises.`,
        created_by: args.actor.id,
      });
    }

    void logAudit(admin, {
      entityType: "booking",
      entityId: args.bookingId,
      action: "update",
      performedBy: args.actor.id,
      changes: {
        provisional_checkin: {
          old: null,
          new: `Checked in on an unverified UPI payment (${args.bookingNumber})`,
        },
      },
    });
  } catch (err) {
    console.error("[booking-payment-report] provisional check-in note failed:", err);
  }
}
