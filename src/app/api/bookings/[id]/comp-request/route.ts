/**
 * GET /api/bookings/[id]/comp-request
 *
 * Returns the most recent comp_request approval_request for this booking
 * (any status). Used by the booking detail page to surface comp request
 * state in the lifecycle timeline and next-action banner.
 *
 * Returns { data: null } when no comp request exists.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: bookingId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("approval_requests")
    .select(`
      id, status, reason, metadata, rejection_reason,
      requested_by, created_at, expires_at, acted_at,
      requester:users!approval_requests_requested_by_fkey(id, full_name),
      actor:users!approval_requests_acted_by_fkey(id, full_name)
    `)
    .eq("entity_id", bookingId)
    .eq("approval_type", "comp_request")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? null });
}

/**
 * POST /api/bookings/[id]/comp-request
 *
 * Floor managers submit a complimentary-booking approval request.
 * Creates a row in the generic `approval_requests` table
 * (approval_type = 'comp_request', entity_type = 'booking'),
 * then fires email + in-app notifications to all active admins
 * and managers.
 *
 * The request expires after 24 hours if not acted on.
 *
 * Approval / rejection is handled by the existing
 * PATCH /api/approval-requests/[id] endpoint (extended for comp_request).
 *
 * Refuses if:
 *   - Caller is not floor_manager
 *   - Booking is already cancelled or already waived
 *   - A verified payment has been collected (force the refund flow)
 *   - A pending comp request for this booking already exists
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import {
  BOOKING_COMPLIMENTARY_REASON_LABELS,
} from "@/lib/constants";
import type { BookingComplimentaryReason } from "@/types";

const VALID_REASONS = new Set([
  "manager_goodwill", "aggregator_demo", "staff_use",
  "event_partnership", "other",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: bookingId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only floor managers use this route
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name, email")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "floor_manager") {
    return NextResponse.json(
      { error: "Only floor managers can submit comp requests. Admins/managers can mark directly." },
      { status: 403 }
    );
  }

  const body = await request.json();
  const reason = body.reason as string | undefined;
  const details = (body.details as string | undefined)?.trim() || null;

  if (!reason || !VALID_REASONS.has(reason)) {
    return NextResponse.json(
      { error: "reason is required (must be a valid picklist value)" },
      { status: 400 }
    );
  }
  if (reason === "other" && !details) {
    return NextResponse.json(
      { error: "details required when reason is 'other'" },
      { status: 400 }
    );
  }

  // ── Validate booking ─────────────────────────────────────────────────────
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, booking_number, status, payment_status, total_amount_with_gst, space:spaces!bookings_space_id_fkey(name)")
    .eq("id", bookingId)
    .single();

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "Cannot request comp for a cancelled booking" }, { status: 400 });
  }
  if (booking.payment_status === "waived") {
    return NextResponse.json({ error: "Booking is already complimentary" }, { status: 400 });
  }

  // Block if payment has been collected
  const { data: paidPayments } = await supabase
    .from("booking_payments")
    .select("id, amount")
    .eq("booking_id", bookingId)
    .eq("status", "verified");
  const totalCollected = (paidPayments || []).reduce((s, p) => s + Number(p.amount), 0);
  if (totalCollected > 0) {
    return NextResponse.json(
      {
        error: `Cannot request comp — ₹${totalCollected.toFixed(2)} has already been collected. A refund must be issued first.`,
      },
      { status: 400 }
    );
  }

  // ── Check for duplicate pending request ──────────────────────────────────
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("approval_requests")
    .select("id, created_at")
    .eq("entity_id", bookingId)
    .eq("approval_type", "comp_request")
    .eq("status", "pending")
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "A comp request for this booking is already pending approval." },
      { status: 400 }
    );
  }

  // ── Create the approval request ──────────────────────────────────────────
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const spaceName = (booking.space as { name?: string } | null)?.name ?? null;
  const reasonLabel =
    BOOKING_COMPLIMENTARY_REASON_LABELS[reason as BookingComplimentaryReason] ?? reason;

  const { data: approvalReq, error: insertErr } = await admin
    .from("approval_requests")
    .insert({
      approval_type:    "comp_request",
      entity_type:      "booking",
      entity_id:        bookingId,
      entity_reference: booking.booking_number,
      requested_by:     dbUser.id,
      reason:           reason,
      metadata: {
        booking_number:        booking.booking_number,
        space_name:            spaceName,
        reason_label:          reasonLabel,
        details:               details,
        total_amount_with_gst: Number(booking.total_amount_with_gst) || 0,
        requested_by_name:     dbUser.full_name,
        requested_by_email:    dbUser.email,
      },
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (insertErr || !approvalReq) {
    return NextResponse.json(
      { error: "Failed to create request: " + (insertErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  logAudit(admin, {
    entityType: "booking",
    entityId:   bookingId,
    action:     "update",
    performedBy: dbUser.id,
    changes: {
      comp_request_submitted: { old: null, new: approvalReq.id },
      reason:                 { old: null, new: reason },
    },
  });

  // ── Fetch admins + managers to notify ────────────────────────────────────
  const { data: approvers } = await admin
    .from("users")
    .select("id, full_name, email, phone")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);

  const approverList = approvers || [];

  // ── In-app notifications ──────────────────────────────────────────────────
  if (approverList.length > 0) {
    await createNotificationsForUsers(
      approverList.map(u => u.id),
      {
        type:       "comp_request",
        title:      `Comp Request — ${booking.booking_number}`,
        body:       `${dbUser.full_name} has requested a complimentary booking for ${booking.booking_number}${spaceName ? ` (${spaceName})` : ""}. Reason: ${reasonLabel}`,
        url:        `/bookings/${booking.booking_number}`,
        entityType: "booking",
        entityId:   bookingId,
      }
    );
  }

  // ── Email notification to approvers ──────────────────────────────────────
  const crmLink = `${process.env.NEXT_PUBLIC_APP_URL || "https://crm.theworkvilla.com"}/bookings/${booking.booking_number}`;
  const totalDisplay = Number(booking.total_amount_with_gst) > 0
    ? `₹${Number(booking.total_amount_with_gst).toLocaleString("en-IN")}`
    : "₹0";

  const emailHtml = `
    <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
      <div style="background:#f0fdf4; border-left:4px solid #16a34a; padding:16px 20px; border-radius:4px; margin-bottom:20px;">
        <p style="margin:0; font-size:14px; font-weight:600; color:#15803d;">
          🎁 Complimentary Booking Request
        </p>
      </div>

      <p style="font-size:14px; margin-bottom:16px;">
        <strong>${dbUser.full_name}</strong> has requested approval to mark a booking as complimentary.
      </p>

      <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:20px;">
        <tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; width:40%; border:1px solid #e5e7eb;">Booking</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${booking.booking_number}${spaceName ? ` — ${spaceName}` : ""}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Current Total</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${totalDisplay}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Reason</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${reasonLabel}</td>
        </tr>
        ${details ? `<tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Details</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${details}</td>
        </tr>` : ""}
        <tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Requested by</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">${dbUser.full_name} (${dbUser.email || "floor manager"})</td>
        </tr>
        <tr>
          <td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Expires</td>
          <td style="padding:8px 12px; border:1px solid #e5e7eb;">24 hours from now</td>
        </tr>
      </table>

      <p style="margin-bottom:20px;">
        <a href="${crmLink}" style="display:inline-block; padding:10px 20px; background:#015E65; color:#fff; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">
          Review in CRM →
        </a>
      </p>

      <p style="font-size:12px; color:#6b7280;">
        You can approve or reject this request from the Approvals bell in the CRM nav, or by visiting the booking page directly.
        This request will auto-expire in 24 hours if no action is taken.
      </p>
    </div>
  `;

  const approverEmails = approverList.map(u => u.email).filter(Boolean) as string[];
  if (approverEmails.length > 0) {
    await resend.emails.send({
      from:    EMAIL_FROM,
      to:      approverEmails,
      subject: `Comp Request — ${booking.booking_number} | ${dbUser.full_name}`,
      html:    emailHtml,
    }).catch(err => console.error("[comp-request] email failed:", err));
  }

  // ── WhatsApp notifications — intentionally not sent ───────────────────────
  // This used "comp_request_notify", which was never created in MSG91 (the
  // original comment here said as much). Every send failed with "template name
  // does not exist in en". No approved template fits an internal comp-request
  // alert — internal_new_lead would tell approvers this is a "New lead" — so
  // approvers are notified by the email above until the template is approved.

  return NextResponse.json({
    data: { id: approvalReq.id, expires_at: expiresAt },
    message: "Approval request submitted. Managers have been notified and will review shortly.",
  });
}
