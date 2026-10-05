import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { messaging } from "@/lib/whatsapp";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { executeBookingCancellationSideEffects } from "@/lib/booking-cancel";
import { maybeCreateBookingGstTask } from "@/lib/booking-gst-task";
import { deleteUserFromDevice } from "@/lib/cosec";
import { computeVoucherSeatCap } from "@/lib/booking-vouchers";
import { getCachedSettings } from "@/lib/app-settings-cache";

export const maxDuration = 30;

const BOOKING_SELECT = "*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate, location_id, workspace_type, cosec_device_id), location:locations!bookings_location_id_fkey(id, name, code, address, city, state, wifi_voucher_mode), contract:contracts!bookings_contract_id_fkey(id, contract_number, lead_id), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, id_proof_path), facilities:booking_facilities(*)";

/** Actual duration in hours between two real timestamps, rounded UP to the
 *  next whole hour. Both check_in_at/check_out_at are proper UTC
 *  timestamptz values, so plain Date arithmetic is correct here — unlike
 *  the booking.end_time comparison above (a bare "HH:MM" wall-clock
 *  string with no timezone, implicitly IST), this never needs the
 *  Intl/Asia-Kolkata dance. */
function roundedActualHours(checkInIso: string, checkOutAt: Date): number {
  const checkIn = new Date(checkInIso);
  const minutes = (checkOutAt.getTime() - checkIn.getTime()) / 60000;
  return Math.ceil(Math.max(0, minutes) / 60);
}

/** Wall-clock time in IST for display in charge descriptions — check_in_at
 *  and check_out_at are proper UTC timestamptz values, so this just needs
 *  an explicit timeZone, not the bare-string IST dance used elsewhere. */
function formatIstTime(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d).toUpperCase();
}

/**
 * Best-effort cancel of a booking's existing Razorpay payment link. Called
 * when a reschedule changes the amount due, so a stale link can no longer
 * be paid at the old (wrong) amount — see TWV-B-0219, where a reschedule
 * left the previously-issued link showing an amount that no longer matched
 * the booking. Never throws: a failed cancel just means the old link stays
 * live at Razorpay until it expires on its own, which is not worse than the
 * status quo before this existed.
 */
async function cancelStaleBookingPaymentLink(linkId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const settings = await getCachedSettings(admin, [
      "razorpay_key_id",
      "razorpay_key_secret",
      "razorpay_enabled",
    ]);
    if (settings["razorpay_enabled"] !== "true") return;
    const keyId = settings["razorpay_key_id"];
    const keySecret = settings["razorpay_key_secret"];
    if (!keyId || !keySecret) return;

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn("[reschedule] Could not cancel stale payment link (non-fatal):", err);
  }
}

/**
 * Model B (pooled monthly usage). See docs plan "Pooled Monthly Usage
 * Billing (Model B)".
 *
 * Computes and posts this booking's contribution to its contract_facility's
 * monthly pooled-usage charge: actual duration (check_in_at → check_out_at,
 * rounded up to the next whole hour), pooled sequentially against every
 * other already-checked-out booking this calendar month for the same
 * contract + facility (ordered by true checkout chronology — created_at,
 * not booking_date), charged only for hours beyond the facility's
 * free_quota.
 *
 * This is now the ONLY mechanism that charges a contract-holder booking
 * against an hour-based facility — no charge is created at booking time
 * (see bookings/route.ts), and the old checkout-time "overtime" charge
 * (time past the booked slot, charged separately from quota/overage) has
 * been retired in favor of this single unified charge. A shadow-gated
 * rollout (allowlisted test contracts only, both mechanisms running in
 * parallel) preceded this cutover — no gate remains; this runs for every
 * contract now.
 */
async function maybePostPooledUsageCharge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  params: {
    bookingId: string;
    contractId: string;
    spaceId: string;
    bookingDate: string;
    checkInAt: string;
    checkOutAt: Date;
    createdBy: string;
    bookedHours: number;
    /** Staff-set substitute allocation from booking creation (see migration
     *  00553) — when present, pool against this facility directly instead
     *  of re-deriving one from the space name. Keeps checkout consistent
     *  with whatever was decided when the booking was made. */
    contractFacilityIdOverride?: string | null;
  }
): Promise<void> {
  const { bookingId, contractId, spaceId, bookingDate, checkInAt, checkOutAt, createdBy, bookedHours, contractFacilityIdOverride } = params;

  const HOUR_UNITS = ["hr", "hrs", "hour", "hours", "h"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facility: any;

  if (contractFacilityIdOverride) {
    const { data: overrideFacility } = await supabase
      .from("contract_facilities")
      .select("id, name, free_quota, cost_per_unit")
      .eq("id", contractFacilityIdOverride)
      .maybeSingle();
    if (!overrideFacility) return; // override facility deleted since booking — nothing to pool against
    facility = overrideFacility;
  } else {
    // Resolve the hour-based contract_facility for this space — the same
    // name-match heuristic used at booking creation, promoted here to the
    // only path since Model B never links a booking to a charge at
    // creation time (there's no booking.usage_charge_id to originate from).
    const [{ data: spaceRow }, { data: facilities }] = await Promise.all([
      supabase.from("spaces").select("name").eq("id", spaceId).maybeSingle(),
      supabase
        .from("contract_facilities")
        .select("id, name, free_quota, cost_per_unit")
        .eq("contract_id", contractId)
        .in("unit", HOUR_UNITS),
    ]);
    if (!facilities || facilities.length === 0) return; // no hour-based quota on this contract — nothing to pool

    const spaceLower = (spaceRow?.name || "").toLowerCase();
    // No "first row" fallback when ambiguous — mirrors the tightened logic
    // at booking creation (see bookings/route.ts). An ambiguous booking's
    // facility_resolution is already 'unresolved' from creation time, so
    // there's nothing to pool here either; Accounts resolves it manually.
    facility =
      facilities.length === 1
        ? facilities[0]
        : facilities.find(
            (f: { name: string }) =>
              spaceLower.includes(f.name.toLowerCase()) || f.name.toLowerCase().includes(spaceLower)
          ) || null;
    if (!facility) return;
  }

  const actualHours = roundedActualHours(checkInAt, checkOutAt);
  if (actualHours <= 0) return;

  // Pool against every other already-checked-out booking this calendar
  // month for this contract + facility. Summing `quantity` on prior
  // pooled_usage charges gives hours consumed so far directly — each
  // charge's quantity IS that booking's full rounded actual duration
  // (see insert below), regardless of how much of it was free vs. paid,
  // so this sum is exactly the running pool total the next booking needs.
  const [year, month] = bookingDate.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const { data: priorCharges } = await supabase
    .from("usage_charges")
    .select("quantity")
    .eq("contract_id", contractId)
    .eq("contract_facility_id", facility.id)
    .eq("booking_charge_kind", "pooled_usage")
    .gte("charge_date", monthStart)
    .lte("charge_date", monthEnd)
    .order("created_at", { ascending: true });
  const hoursConsumedSoFar = (priorCharges || []).reduce(
    (sum: number, c: { quantity: number }) => sum + Number(c.quantity || 0),
    0
  );

  const freeQuota = Number(facility.free_quota);
  const freeRemaining = Math.max(0, freeQuota - hoursConsumedSoFar);
  const overageHours = Math.max(0, actualHours - freeRemaining);
  const rate = Number(facility.cost_per_unit);
  const total = parseFloat((overageHours * rate).toFixed(2));

  const { data: contractRow } = await supabase
    .from("contracts")
    .select("lead_id, tax_percentage")
    .eq("id", contractId)
    .single();
  const gstRate = Number(contractRow?.tax_percentage ?? 18);
  const gstAmount = parseFloat((total * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((total + gstAmount).toFixed(2));

  // Split the charged (overage) hours into "usage" (within the booked
  // slot) vs. "extra" (checkout ran past the booked end time) — purely
  // descriptive, doesn't change quantity/total/gst below. Mirrors the
  // display-only split in contract-bookings-section.tsx so both places
  // read consistently.
  const extraHoursNeeded = Math.max(0, actualHours - bookedHours);
  const extraBilled = Math.min(overageHours, extraHoursNeeded);
  const usageBilled = overageHours - extraBilled;
  const bookedNote = extraHoursNeeded > 0 ? `, ${bookedHours}hr booked` : "";
  const timeRange = `${formatIstTime(new Date(checkInAt))} – ${formatIstTime(checkOutAt)}`;

  const chargedParts = [
    ...(usageBilled > 0 ? [`${usageBilled}hr usage`] : []),
    ...(extraBilled > 0 ? [`${extraBilled}hr extra`] : []),
  ];
  const chargedSegment = `${chargedParts.join(" + ")} charged`;

  const description = overageHours > 0
    ? `Pooled usage: ${facility.name} — ${timeRange} (${actualHours}hr actual${bookedNote}) — ${hoursConsumedSoFar}hr already used this month, ${freeQuota}hr/mo free — ${chargedSegment}`
    : `Pooled usage: ${facility.name} — ${timeRange} (${actualHours}hr actual${bookedNote}, within ${freeQuota}hr/mo quota, ${hoursConsumedSoFar + actualHours}hr used total)`;

  const { error } = await supabase.from("usage_charges").insert({
    contract_id: contractId,
    booking_id: bookingId,
    lead_id: contractRow?.lead_id ?? null,
    contract_facility_id: facility.id,
    booking_charge_kind: "pooled_usage",
    description,
    quantity: actualHours,
    billed_quantity: overageHours,
    unit_price: rate,
    total,
    gst_rate: gstRate,
    gst_amount: gstAmount,
    total_with_gst: totalWithGst,
    charge_date: bookingDate,
    status: overageHours > 0 ? "pending" : "waived",
    created_by: createdBy,
  });
  if (error) {
    console.error("[checkout] pooled_usage charge insert failed (shadow contract):", error);
  }
}

/**
 * Recompute the booking's GST + grand-total fields from a new ex-GST
 * subtotal. Crucially, this includes the sum of any add-on charges
 * already attached to the booking — without that, editing the rate on a
 * booking that had add-ons would silently drop the add-on amount from
 * the displayed grand total (and the Collect Payment dialog).
 */
async function computeBookingTotalsWithAddons(
  // Same any-client treatment as src/lib/location-incharges.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  bookingId: string,
  newSubtotal: number,
  gstRate: number,
): Promise<{ total_amount: number; gst_amount: number; total_amount_with_gst: number }> {
  const baseGstAmount = parseFloat((newSubtotal * gstRate / 100).toFixed(2));

  const { data: addons } = await supabase
    .from("booking_addons")
    .select("total_with_gst")
    .eq("booking_id", bookingId);
  const addonTotal = (addons || []).reduce(
    (s: number, a: { total_with_gst: number | string }) => s + Number(a.total_with_gst),
    0
  );

  const totalWithGst = parseFloat((newSubtotal + baseGstAmount + addonTotal).toFixed(2));
  return {
    total_amount: newSubtotal,
    gst_amount: baseGstAmount,
    total_amount_with_gst: totalWithGst,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Also fetch voucher issuances for this booking — both active AND revoked.
  // A revoked issuance is still a real support record (code was issued,
  // emailed to the customer, then killed) and must stay visible on the
  // booking page rather than vanishing entirely. Ordered by seat_number so
  // the display groups by seat regardless of active/revoked status; within
  // a seat, issued_at ascending keeps history (original -> replacement) in
  // chronological order.
  const { data: vouchers } = await supabase
    .from("voucher_issuances")
    .select("*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status)")
    .eq("booking_id", id)
    .order("seat_number", { ascending: true })
    .order("issued_at", { ascending: true });

  // Fetch all feedback for this booking (staff + customer)
  const { data: allFeedbacks } = await supabase
    .from("booking_feedbacks")
    .select("*, rater:users!booking_feedbacks_rated_by_fkey(id, full_name)")
    .eq("booking_id", id);

  const staff_feedback = allFeedbacks?.find(f => f.source === "staff") ?? null;
  const customer_feedback = allFeedbacks?.find(f => f.source === "customer") ?? null;

  // Resolve actor names for the lifecycle timeline
  const actorIds = [data.created_by, data.checked_in_by, data.checked_out_by, data.cancelled_by].filter(Boolean);
  let actorMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("users")
      .select("id, full_name")
      .in("id", actorIds);
    if (actors) {
      actorMap = Object.fromEntries(actors.map((a: { id: string; full_name: string }) => [a.id, a.full_name]));
    }
  }

  // Resolve quota info for contract-holder bookings (waived = within free quota)
  let quotaInfo: { monthly_quota: number; used_this_month: number; remaining_after: number } | null = null;
  if (data.contract_id && data.payment_status === "waived" && data.customer_type === "contract_holder") {
    const HOUR_UNITS = ["hr", "hrs", "hour", "hours", "h"];
    const bDate = new Date(data.booking_date + "T00:00:00");
    const yr = bDate.getFullYear();
    const mo = bDate.getMonth();
    const monthStart = new Date(yr, mo, 1).toISOString().split("T")[0];
    const monthEnd   = new Date(yr, mo + 1, 0).toISOString().split("T")[0];

    const [{ data: facilities }, { data: monthBookings }] = await Promise.all([
      supabase
        .from("contract_facilities")
        .select("free_quota")
        .eq("contract_id", data.contract_id)
        .in("unit", HOUR_UNITS)
        .limit(1),
      supabase
        .from("bookings")
        .select("id, duration_hours")
        .eq("contract_id", data.contract_id)
        .gte("booking_date", monthStart)
        .lte("booking_date", monthEnd)
        .in("status", ["confirmed", "checked_in", "checked_out"]),
    ]);

    if (facilities && facilities.length > 0) {
      const monthlyQuota = Number(facilities[0].free_quota);
      const usedThisMonth = (monthBookings || []).reduce(
        (sum: number, b: { id: string; duration_hours: number | null }) =>
          sum + Number(b.duration_hours || 0),
        0
      );
      quotaInfo = {
        monthly_quota: monthlyQuota,
        used_this_month: usedThisMonth,
        remaining_after: Math.max(0, monthlyQuota - usedThisMonth),
      };
    }
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    await logView(supabase, { entityType: "booking", entityId: id, performedBy: dbUser.id });
  }

  // Most recent PIN delivery outcome, if any (logged post-delivery by provision-booking-access.ts).
  // Historical bookings / PINs provisioned before this logging change will have none — that's expected.
  let pinDelivery: { whatsapp: string; sms: string; email: string; at: string } | null = null;
  try {
    const { data: deliveryAudit, error: deliveryError } = await supabase
      .from("audit_trail")
      .select("changes, created_at")
      .eq("entity_type", "booking")
      .eq("entity_id", id)
      .not("changes->pin_delivery", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (deliveryError) {
      console.error("Failed to fetch pin_delivery audit row:", deliveryError);
    } else if (deliveryAudit?.changes?.pin_delivery?.new) {
      const delivery = deliveryAudit.changes.pin_delivery.new as { whatsapp: string; sms: string; email: string };
      pinDelivery = { ...delivery, at: deliveryAudit.created_at };
    }
  } catch (err) {
    console.error("Failed to fetch pin_delivery audit row:", err);
  }

  return NextResponse.json({
    data: {
      ...data,
      voucher_issuances: vouchers || [],
      feedback: staff_feedback,
      customer_feedback,
      created_by_name: actorMap[data.created_by] || null,
      checked_in_by_name: actorMap[data.checked_in_by] || null,
      checked_out_by_name: actorMap[data.checked_out_by] || null,
      cancelled_by_name: actorMap[data.cancelled_by] || null,
      quota_info: quotaInfo,
      pin_delivery: pinDelivery,
      voucher_seat_cap: computeVoucherSeatCap(data, data.space as { capacity?: number | null } | null),
    },
  });
}

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

  const { data: booking } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  // ── Update pricing ──
  if (body.action === "update_pricing") {
    // Lock pricing once the booking is in a terminal state OR money has
    // already been collected. Editing the rate after the customer paid
    // ₹X creates a silent mismatch between the receipt they were given
    // and the booking record — the original reason finance flagged this.
    if (["cancelled", "checked_out", "no_show"].includes(booking.status)) {
      return NextResponse.json(
        { error: `Cannot update pricing on a ${booking.status} booking` },
        { status: 400 }
      );
    }
    if (booking.payment_status === "paid") {
      return NextResponse.json(
        { error: "Cannot change pricing — payment has already been collected. Issue a refund or new booking instead." },
        { status: 400 }
      );
    }
    // Defence in depth: even if booking.payment_status is somehow stale,
    // verified booking_payments is the source of truth.
    const { data: paidPayments } = await supabase
      .from("booking_payments")
      .select("id")
      .eq("booking_id", id)
      .eq("status", "verified")
      .limit(1);
    if (paidPayments && paidPayments.length > 0) {
      return NextResponse.json(
        { error: "Cannot change pricing — verified payments exist for this booking" },
        { status: 400 }
      );
    }

    const newRate = Number(body.hourly_rate);
    const newTotal = Number(body.total_amount);
    if (isNaN(newRate) || newRate < 0)
      return NextResponse.json({ error: "hourly_rate must be 0 or greater" }, { status: 400 });
    if (isNaN(newTotal) || newTotal < 0)
      return NextResponse.json({ error: "total_amount must be 0 or greater" }, { status: 400 });

    // Recompute GST against the existing gst_rate AND fold in any
    // add-on charges already attached. The previous version dropped
    // add-ons from total_amount_with_gst on a rate edit; this preserves
    // them so the Collect Payment dialog and receipts stay correct.
    const totals = await computeBookingTotalsWithAddons(
      supabase, id, newTotal, Number(booking.gst_rate ?? 0)
    );

    const { data: updated, error: updateErr } = await supabase
      .from("bookings")
      .update({
        hourly_rate: newRate,
        total_amount: totals.total_amount,
        gst_amount: totals.gst_amount,
        total_amount_with_gst: totals.total_amount_with_gst,
      })
      .eq("id", id)
      .select(BOOKING_SELECT)
      .single();
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
    return NextResponse.json({ data: updated });
  }

  // ── Reschedule action ──
  if (body.action === "reschedule") {
    if (booking.status !== "confirmed") {
      return NextResponse.json({ error: "Can only reschedule confirmed bookings" }, { status: 400 });
    }
    const { new_date, new_start_time, new_end_time } = body;
    if (!new_date || !new_start_time || !new_end_time) {
      return NextResponse.json({ error: "new_date, new_start_time, new_end_time required" }, { status: 400 });
    }

    // Check availability
    const { data: conflicts } = await supabase
      .from("bookings")
      .select("id")
      .eq("space_id", booking.space_id)
      .eq("booking_date", new_date)
      .not("status", "in", "(cancelled,no_show)")
      .neq("id", id)
      .lt("start_time", new_end_time)
      .gt("end_time", new_start_time);

    if (conflicts && conflicts.length > 0) {
      return NextResponse.json({ error: "New slot is not available" }, { status: 409 });
    }

    const [rsh, rsm] = new_start_time.split(":").map(Number);
    const [reh, rem] = new_end_time.split(":").map(Number);
    const newDuration = (reh * 60 + rem - rsh * 60 - rsm) / 60;
    const newTotal = Number(booking.hourly_rate) * newDuration;

    // Keep GST in sync with the recalculated subtotal AND include any
    // existing add-ons in the grand total (same addon-aware helper as
    // update_pricing above).
    const rsTotals = await computeBookingTotalsWithAddons(
      supabase, id, newTotal, Number(booking.gst_rate ?? 0)
    );

    updates.booking_date = new_date;
    updates.start_time = new_start_time;
    updates.end_time = new_end_time;
    updates.duration_hours = newDuration;
    updates.total_amount = rsTotals.total_amount;
    updates.gst_amount = rsTotals.gst_amount;
    updates.total_amount_with_gst = rsTotals.total_amount_with_gst;
    updates.reschedule_count = (booking.reschedule_count || 0) + 1;
    if (!booking.original_booking_date) {
      updates.original_booking_date = booking.booking_date;
      updates.original_start_time = booking.start_time;
      updates.original_end_time = booking.end_time;
    }

    // A payment link already sent to the customer is now stale if the total
    // changed — cancel it and clear it from the booking so the next "Share
    // Payment Link" click generates a fresh one off the corrected total,
    // instead of resending the old (wrong) amount. Staff still control when
    // the customer actually gets messaged; this only stops the wrong link
    // from being payable.
    if (
      booking.razorpay_payment_link_id &&
      Number(rsTotals.total_amount_with_gst) !== Number(booking.total_amount_with_gst)
    ) {
      await cancelStaleBookingPaymentLink(booking.razorpay_payment_link_id as string);
      updates.razorpay_payment_link_id = null;
      updates.razorpay_payment_link_url = null;
    }
  }

  // ── Extend action (for checked-in bookings) ──
  if (body.action === "extend") {
    if (booking.status !== "checked_in") {
      return NextResponse.json({ error: "Can only extend checked-in bookings" }, { status: 400 });
    }
    const { new_end_time } = body;
    if (!new_end_time) {
      return NextResponse.json({ error: "new_end_time required" }, { status: 400 });
    }

    if (new_end_time <= booking.end_time.slice(0, 5)) {
      return NextResponse.json({ error: "New end time must be after current end time" }, { status: 400 });
    }

    // Check no conflicts with next booking
    const { data: extConflicts } = await supabase
      .from("bookings")
      .select("id")
      .eq("space_id", booking.space_id)
      .eq("booking_date", booking.booking_date)
      .not("status", "in", "(cancelled,no_show)")
      .neq("id", id)
      .lt("start_time", new_end_time)
      .gt("end_time", booking.end_time.slice(0, 5));

    if (extConflicts && extConflicts.length > 0) {
      return NextResponse.json({ error: "Cannot extend — next booking conflict" }, { status: 409 });
    }

    const [esh, esm] = booking.start_time.split(":").map(Number);
    const [eeh, eem] = new_end_time.split(":").map(Number);
    const extDuration = (eeh * 60 + eem - esh * 60 - esm) / 60;
    const extTotal = Number(booking.hourly_rate) * extDuration;
    const priceDiff = extTotal - Number(booking.total_amount);

    // Same addon-aware recompute as update_pricing / reschedule.
    const extTotals = await computeBookingTotalsWithAddons(
      supabase, id, extTotal, Number(booking.gst_rate ?? 0)
    );

    updates.end_time = new_end_time;
    updates.duration_hours = extDuration;
    updates.total_amount = extTotals.total_amount;
    updates.gst_amount = extTotals.gst_amount;
    updates.total_amount_with_gst = extTotals.total_amount_with_gst;

    const { data: extUpdated, error: extError } = await supabase
      .from("bookings")
      .update(updates)
      .eq("id", id)
      .select(BOOKING_SELECT)
      .single();

    if (extError) return NextResponse.json({ error: extError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "booking",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        end_time: { old: booking.end_time, new: new_end_time },
        duration_hours: { old: booking.duration_hours, new: extDuration },
        total_amount: { old: booking.total_amount, new: extTotal },
      },
    });

    return NextResponse.json({
      data: extUpdated,
      extension: {
        old_end_time: booking.end_time.slice(0, 5),
        new_end_time,
        old_duration: booking.duration_hours,
        new_duration: extDuration,
        price_difference: Math.round(priceDiff),
      },
    });
  }

  // ── Notes update ──
  if (body.notes !== undefined && !body.status && !body.action) {
    updates.notes = body.notes;
  }

  // Status transitions
  if (body.status) {
    const { status: newStatus } = body;
    const canManage = ["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin"].includes(dbUser.role);

    switch (newStatus) {
      case "checked_in": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only check in confirmed bookings" }, { status: 400 });
        }

        // Day-pass spaces: enforce that check-in happens during the centre's
        // operating hours for that day. Outside that window, the staff should
        // either reschedule or extend the booking explicitly.
        if (booking.pricing_model === "daily" && booking.space?.operating_hours) {
          const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          const now = new Date();
          const dayKey = days[now.getDay()];
          const todayHours = booking.space.operating_hours[dayKey];
          if (todayHours?.is_open) {
            const [oH, oM] = todayHours.open.split(":").map(Number);
            const [cH, cM] = todayHours.close.split(":").map(Number);
            const nowMin = now.getHours() * 60 + now.getMinutes();
            const openMin = oH * 60 + oM;
            const closeMin = cH * 60 + cM;
            if (nowMin < openMin || nowMin > closeMin) {
              return NextResponse.json({
                error: `Day-pass check-in must be during centre hours (${todayHours.open} – ${todayHours.close})`,
              }, { status: 400 });
            }
          }
        }

        // PAYMENT GATE: Walk-in bookings require full payment before check-in.
        // We compare against the GST-inclusive grand total, the same figure
        // the customer is told to pay — using ex-GST here would have let
        // walk-ins check in after paying only the pre-tax amount.
        if (booking.customer_type === "walk_in") {
          const { data: verifiedPayments } = await supabase
            .from("booking_payments")
            .select("amount")
            .eq("booking_id", id)
            .eq("status", "verified");

          const totalPaid = (verifiedPayments || []).reduce(
            (sum: number, p: { amount: number }) => sum + Number(p.amount), 0
          );
          const grandTotal = Number(booking.total_amount_with_gst || booking.total_amount);

          if (totalPaid < grandTotal) {
            return NextResponse.json({
              error: "Payment required before check-in",
              payment_required: true,
              total_amount: grandTotal,
              amount_paid: totalPaid,
              balance_due: grandTotal - totalPaid,
            }, { status: 402 });
          }
        }

        updates.status = "checked_in";
        updates.check_in_at = new Date().toISOString();
        updates.checked_in_by = dbUser.id;
        break;
      }

      case "checked_out": {
        if (booking.status !== "checked_in") {
          return NextResponse.json({ error: "Can only check out checked-in bookings" }, { status: 400 });
        }
        const now = new Date();
        updates.status = "checked_out";
        updates.check_out_at = now.toISOString();
        updates.checked_out_by = dbUser.id;

        // Calculate overtime if checkout is past booking end_time.
        // booking.end_time is stored as IST clock time ("HH:MM"), so the
        // actual checkout has to be expressed in IST too. now.getHours()
        // returns the runtime's local hours — UTC on Vercel — which made
        // overtime detection silently wrong (off by 5h30). Use Intl with
        // an explicit Asia/Kolkata timezone instead.
        const bookingEndMin = (() => {
          const [h, m] = (booking.end_time || "00:00").split(":").map(Number);
          return h * 60 + m;
        })();
        const istParts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const istHour = Number(istParts.find((p) => p.type === "hour")?.value ?? 0);
        const istMinute = Number(istParts.find((p) => p.type === "minute")?.value ?? 0);
        const actualCheckoutMin = istHour * 60 + istMinute;

        // Only flag overtime if checkout is past the booked end_time by > 15 minutes
        const overtimeMinutes = actualCheckoutMin - bookingEndMin;
        if (overtimeMinutes > 15 && !body.skip_overtime) {
          const overtimeHours = Math.ceil(overtimeMinutes / 60);

          if (booking.pricing_model === "daily") {
            // Day-pass: never multiply day rate by hours. Surface a suggestion to
            // add the catalogued "Extended hour" add-on (₹100/hr by default,
            // editable in the addon catalog).
            const { data: extendedItem } = await supabase
              .from("addon_catalog")
              .select("id, name, unit_price, gst_rate")
              .eq("addon_type", "extended_time")
              .eq("is_active", true)
              .or(`location_id.eq.${booking.location_id},location_id.is.null`)
              .order("location_id", { ascending: false, nullsFirst: false })
              .limit(1)
              .maybeSingle();

            const unitPrice = Number(extendedItem?.unit_price ?? 100);
            const gstRate = Number(extendedItem?.gst_rate ?? 18);
            const overtimeCharge = parseFloat((overtimeHours * unitPrice).toFixed(2));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (updates as any)._overtime = {
              minutes: overtimeMinutes,
              hours: overtimeHours,
              unit_price: unitPrice,
              gst_rate: gstRate,
              charge: overtimeCharge,
              addon_catalog_id: extendedItem?.id ?? null,
              suggested_addon: {
                addon_type: "extended_time",
                description: extendedItem?.name ?? "Extended hour",
                unit_label: "per hour",
                quantity: overtimeHours,
                unit_price: unitPrice,
                gst_rate: gstRate,
              },
              is_day_pass: true,
            };
          } else if (booking.customer_type === "contract_holder" && booking.contract_id) {
            // Intentionally a no-op. Contract-holder charging against an
            // hour-based facility is now handled unconditionally below by
            // maybePostPooledUsageCharge (Model B — pooled monthly usage),
            // regardless of whether checkout ran past the booked end time.
            // This branch exists only so a contract-holder late checkout
            // doesn't fall through to the walk-in/guest `else` below and
            // get a spurious ephemeral `_overtime` suggestion in the
            // response — it was never a real charge for them anyway.
          } else {
            const hourlyRate = Number(booking.hourly_rate || booking.space?.hourly_rate || 0);
            const overtimeCharge = overtimeHours * hourlyRate;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (updates as any)._overtime = {
              minutes: overtimeMinutes,
              hours: overtimeHours,
              hourly_rate: hourlyRate,
              charge: overtimeCharge,
              is_day_pass: false,
            };
          }
        }

        // Model B — pooled monthly usage. Runs regardless of overtimeMinutes:
        // every checked-out hour-facility booking contributes to the monthly
        // pool, not just late ones. No-ops instantly if the contract has no
        // hour-based facility configured. See maybePostPooledUsageCharge.
        if (booking.customer_type === "contract_holder" && booking.contract_id && booking.check_in_at) {
          await maybePostPooledUsageCharge(supabase, {
            bookingId: id,
            contractId: booking.contract_id,
            spaceId: booking.space_id,
            bookingDate: booking.booking_date,
            checkInAt: booking.check_in_at,
            checkOutAt: now,
            createdBy: dbUser.id,
            bookedHours: Number(booking.duration_hours),
            contractFacilityIdOverride: booking.contract_facility_id_override,
          });
        }

        // Revoke any active WiFi vouchers on checkout (fire-and-forget, non-fatal).
        // Only revokes vouchers — does not waive usage charge or touch waitlist.
        executeBookingCancellationSideEffects(supabase, {
          bookingId: id,
          customerType: booking.customer_type,
          usageChargeId: null,
          spaceId: booking.space_id,
          bookingDate: booking.booking_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
        }, { skipWaitlistOffer: true, revokeReason: "Booking checked out" })
          .catch((err: unknown) => console.error("[checkout] voucher revocation failed:", err));

        // Remove COSEC device access immediately on checkout (fire-and-forget).
        // The cron at /api/cron/cosec-booking-cleanup is the fallback for any
        // failures here, but triggering on checkout eliminates the up-to-30-min gap.
        void (async () => {
          try {
            const adminClient = createAdminClient();
            const { data: cauRow } = await adminClient
              .from("cosec_access_users")
              .select("id, cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
              .eq("entity_id", id)
              .eq("user_type", "booking")
              .not("enrollment_status", "in", "(deleted,blocked)")
              .maybeSingle();

            if (cauRow) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const dev = cauRow.device as any;
              if (dev) {
                await deleteUserFromDevice(
                  { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
                  cauRow.cosec_user_id,
                );
              }
              const ts = new Date().toISOString();
              await adminClient
                .from("cosec_access_users")
                .update({ enrollment_status: "deleted", deleted_at: ts, updated_at: ts })
                .eq("id", cauRow.id);
            }
          } catch (err) {
            console.error("[checkout] cosec cleanup failed:", err);
          }
        })();

        break;
      }

      case "cancelled": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only cancel confirmed bookings" }, { status: 400 });
        }
        if (!canManage && booking.created_by !== dbUser.id) {
          return NextResponse.json({ error: "Insufficient permissions to cancel" }, { status: 403 });
        }
        updates.status = "cancelled";
        updates.cancellation_reason = body.cancellation_reason || "customer_requested";
        updates.cancelled_by = dbUser.id;
        updates.cancelled_at = new Date().toISOString();

        // Flag GST invoice when payment was collected and retained
        // (consistent with POST /cancel dialog flow).
        const hasPayment = ["paid", "prepaid"].includes(booking.payment_status);
        if (hasPayment) {
          updates.gst_invoice_required = true;
        }

        // Shared side-effects: voucher revocation, usage charge waiver, waitlist auto-offer
        await executeBookingCancellationSideEffects(supabase, {
          bookingId: id,
          customerType: booking.customer_type,
          usageChargeId: booking.usage_charge_id,
          spaceId: booking.space_id,
          bookingDate: booking.booking_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
        });
        break;
      }

      case "no_show": {
        if (booking.status !== "confirmed") {
          return NextResponse.json({ error: "Can only mark no-show on confirmed bookings" }, { status: 400 });
        }
        if (!canManage) {
          return NextResponse.json({ error: "Only managers/floor managers can mark no-show" }, { status: 403 });
        }
        updates.status = "no_show";

        // Flag GST invoice when payment was collected and retained.
        // No-show retains payment by default — finance needs to issue
        // a GST invoice for the kept amount.
        const hasNoShowPayment = ["paid", "prepaid"].includes(booking.payment_status);
        if (hasNoShowPayment) {
          updates.gst_invoice_required = true;
        }

        // Shared side-effects: voucher revocation + usage charge waiver.
        // skipWaitlistOffer = true because the time slot is already past.
        await executeBookingCancellationSideEffects(supabase, {
          bookingId: id,
          customerType: booking.customer_type,
          usageChargeId: booking.usage_charge_id,
          spaceId: booking.space_id,
          bookingDate: booking.booking_date,
          startTime: booking.start_time,
          endTime: booking.end_time,
        }, { skipWaitlistOffer: true });
        break;
      }

      default:
        return NextResponse.json({ error: `Invalid status transition: ${newStatus}` }, { status: 400 });
    }
  }

  // Payment status is managed exclusively through the payment recording
  // workflow (booking_payments table + verified callback). Direct PATCH
  // updates to payment_status / payment_mode / payment_reference are
  // blocked to prevent accidental or malicious status manipulation.

  // Refund fields (refund_status, refund_amount, refund_reason) are no
  // longer accepted via direct PATCH. All refund workflows now go through
  // the refund_requests pipeline (POST /api/refund-requests → approve/reject).

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
  }

  // Extract overtime info before saving (not a DB column)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overtimeInfo = (updates as any)._overtime || null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (updates as any)._overtime;

  const { data: updated, error } = await supabase
    .from("bookings")
    .update(updates)
    .eq("id", id)
    .select(BOOKING_SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Create a Tally Inbox task when the booking is checked out AND already
  // paid. Must run after the update above commits — maybeCreateBookingGstTask
  // re-reads booking.status from the DB, so firing it any earlier would see
  // the pre-checkout status and silently no-op every time. The helper is
  // idempotent (UNIQUE ON booking_id) and fire-and-forget.
  if (body.status === "checked_out") {
    void (async () => {
      try {
        const adminClient = createAdminClient();
        await maybeCreateBookingGstTask(adminClient, id);
      } catch (err) {
        console.error("[checkout] booking-gst-task creation failed:", err);
      }
    })();
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(booking, { ...booking, ...updates }),
  });

  // Log activity on lead timeline for status changes
  if (booking.lead_id && body.status) {
    const spaceName = (updated?.space as { name?: string } | null)?.name || "Conference Room";
    const activityMap: Record<string, { subject: string; description: string }> = {
      checked_in: {
        subject: `Checked In — ${booking.booking_number}`,
        description: `Checked in at ${spaceName} for booking #${booking.booking_number}`,
      },
      checked_out: {
        subject: `Checked Out — ${booking.booking_number}`,
        description: `Checked out from ${spaceName}. Booking #${booking.booking_number}`,
      },
      cancelled: {
        subject: `Booking Cancelled — ${booking.booking_number}`,
        description: `Booking #${booking.booking_number} at ${spaceName} was cancelled`,
      },
      no_show: {
        subject: `No-Show — ${booking.booking_number}`,
        description: `Customer did not show up for booking #${booking.booking_number} at ${spaceName}`,
      },
    };

    const activity = activityMap[body.status];
    if (activity) {
      await supabase.from("activities").insert({
        lead_id: booking.lead_id,
        type: "note",
        subject: activity.subject,
        description: activity.description,
        created_by: dbUser.id,
      });
    }
  }

  // WhatsApp check-in / check-out notifications (fire-and-forget)
  if (body.status === "checked_in" || body.status === "checked_out") {
    const spaceName = (updated?.space as { name?: string } | null)?.name ?? "The Work Villa";
    const guestName = booking.guest_name ?? "Guest";
    const bookingNum = booking.booking_number ?? id;
    const phones = [...new Set([booking.guest_phone, booking.booker_phone].filter(Boolean))] as string[];
    for (const phone of phones) {
      const fn = body.status === "checked_in"
        ? messaging.bookingCheckin(phone, guestName, spaceName, bookingNum, id)
        : messaging.bookingCheckout(phone, guestName, spaceName, bookingNum, id);
      fn.catch((e: unknown) => console.error("[messaging] checkin/checkout WA failed:", e));
    }
  }

  // Auto-send customer feedback link email on checkout (fire-and-forget)
  if (body.status === "checked_out") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = updated as any;
    const customerEmail = u?.lead?.email || u?.guest_email;
    const feedbackToken = u?.feedback_token;
    if (customerEmail && feedbackToken) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app";
      const feedbackUrl = `${appUrl}/feedback/${feedbackToken}`;
      const spaceName = u?.space?.name || "The WorkVilla";
      const customerName = u?.lead?.first_name
        ? `${u.lead.first_name} ${u.lead.last_name || ""}`.trim()
        : (u?.guest_name || "Guest");
      const bookingNumber = u?.booking_number || id;

      resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: customerEmail,
        subject: `How was your experience? — ${bookingNumber} — The WorkVilla`,
        html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
  <div style="background:#015E65;padding:20px 32px;">
    <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Empower your business with flexible workspaces</p>
  </div>
  <div style="padding:32px;">
    <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
    <p style="color:#333;font-size:14px;">Thank you for visiting The WorkVilla! We hope your session at <strong>${spaceName}</strong> was productive.</p>
    <p style="color:#333;font-size:14px;">We'd love to hear about your experience — it only takes a minute and helps us serve you better.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${feedbackUrl}" style="background:#015E65;color:white;padding:14px 36px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;display:inline-block;">Share Your Feedback</a>
    </div>
    <p style="color:#666;font-size:13px;">Booking: <strong>${bookingNumber}</strong> · Space: ${spaceName}</p>
    <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
  </div>
  <div style="background:#015E65;padding:16px 32px;text-align:center;">
    <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034</p>
  </div>
</div>`,
      }).catch((e: unknown) => console.error("[checkout] feedback email failed:", e));
    }
  }

  return NextResponse.json({ data: updated, overtime: overtimeInfo });
}
