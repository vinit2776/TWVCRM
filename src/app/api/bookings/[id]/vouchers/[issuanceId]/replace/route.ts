/**
 * POST /api/bookings/[id]/vouchers/[issuanceId]/replace
 *
 * "Kill this code and give the customer a working one" in a single action.
 * Revokes the given active voucher issuance (same controller logic as
 * POST /api/bookings/[id]/vouchers/[issuanceId]/revoke) and immediately
 * issues one fresh voucher in its place (same issuance logic as
 * POST /api/bookings/[id]/vouchers), linking the new row back to the old
 * one via `replaces_issuance_id`.
 *
 * Body (optional): { reason?: string } — revoke_reason on the old issuance.
 * Defaults to "Replaced with a new code" when omitted.
 *
 * Per-mode behaviour (mirrors the revoke route's module doc):
 *   - UniFi: revokeUnifiVoucher() kills the old code on the controller
 *     first; only once that succeeds do we touch the DB. A brand-new
 *     UniFi voucher is then created with the same duration derivation
 *     (bookingWindowHours on start/end + 60min buffer) and quota (2
 *     devices) as the issue route.
 *   - Ruijie: the installed Ruijie device model has NO revoke capability (see
 *     src/lib/ruijie.ts header comment) — replace is refused with 501,
 *     identical to the revoke route, and nothing is changed.
 *   - Repository: no controller involved. We reserve a replacement code
 *     from the pool BEFORE touching the old issuance — if the pool is
 *     empty we can refuse cleanly and change nothing, which the
 *     UniFi/Ruijie controller-first ordering can't offer us for free.
 *     Once a replacement is reserved, the old voucher_repository row is
 *     marked "revoked" (never returned to "available", matching every
 *     other revoke path in the codebase) and the new one "issued".
 *
 * Because the old issuance is deactivated before the new one is inserted,
 * a replace can never trip the per-booking seat cap (computeVoucherSeatCap
 * in src/lib/booking-vouchers.ts) — net active count is unchanged.
 *
 * Never log the voucher code itself — only issuance ids and the reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { bookingWindowHours } from "@/lib/utils";
import { sendBookingVoucherEmail, computeVoucherSeatCap } from "@/lib/booking-vouchers";
import { createUnifiVoucher, revokeUnifiVoucher, siteConfigFromLocation, isUnifiLocation } from "@/lib/unifi";

const replaceBodySchema = z.object({
  reason: z.string().trim().min(1).optional(),
});

const DEFAULT_REPLACE_REASON = "Replaced with a new code";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; issuanceId: string }> }
) {
  const { id, issuanceId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const rawBody = await request.json().catch(() => ({}));
  const parsedBody = replaceBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }
  const reason = parsedBody.data.reason ?? DEFAULT_REPLACE_REASON;

  // Fetch the issuance and validate it belongs to this booking.
  const { data: issuance, error: issuanceErr } = await supabase
    .from("voucher_issuances")
    .select("id, booking_id, seat_number, is_active, voucher_id, unifi_voucher_id, ruijie_voucher_uuid, lead_id, seat_occupant_email")
    .eq("id", issuanceId)
    .eq("booking_id", id)
    .single();

  if (issuanceErr || !issuance) {
    return NextResponse.json({ error: "Voucher issuance not found for this booking" }, { status: 404 });
  }
  if (!issuance.is_active) {
    return NextResponse.json({ error: "This voucher has already been revoked" }, { status: 409 });
  }

  // ──────────────────────────────────────────────────────────────────
  // RUIJIE: no revoke capability on the controller — refuse, change nothing.
  // ──────────────────────────────────────────────────────────────────
  if (issuance.ruijie_voucher_uuid) {
    return NextResponse.json(
      {
        error:
          "This location's WiFi hardware cannot replace vouchers — revoking requires a revoke capability the Ruijie device model installed here does not have, so the existing code stays usable until it expires on its own. Nothing was changed. Issue an additional voucher instead if the guest needs a working code.",
      },
      { status: 501 }
    );
  }

  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_date, customer_type, location_id, space_id, lead_id, contract_id, guest_email, start_time, end_time, quantity, pricing_model")
    .eq("id", id)
    .single();
  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  let newIssuanceId: string | null = null;

  if (issuance.unifi_voucher_id) {
    // ──────────────────────────────────────────────────────────────
    // UNIFI PATH
    // ──────────────────────────────────────────────────────────────
    const { data: location } = booking.location_id
      ? await supabase
          .from("locations")
          .select("unifi_site_id, unifi_console_id, wifi_voucher_mode")
          .eq("id", booking.location_id)
          .single()
      : { data: null };

    if (!location || !isUnifiLocation(location)) {
      return NextResponse.json(
        { error: "Could not resolve the UniFi site configuration for this booking's location." },
        { status: 502 }
      );
    }
    const siteConfig = siteConfigFromLocation(location);

    // Step 2: kill the old code on the controller first. Nothing is
    // changed in the DB unless this succeeds.
    try {
      await revokeUnifiVoucher(issuance.unifi_voucher_id, siteConfig);
    } catch (err) {
      console.error(`[booking-voucher-replace] Unifi revoke ${issuance.unifi_voucher_id} failed:`, err);
      return NextResponse.json(
        { error: "Failed to revoke the old voucher on the UniFi controller. Nothing was changed." },
        { status: 502 }
      );
    }

    // Step 3: mark the old issuance inactive now that the controller call succeeded.
    const { error: revokeUpdateErr } = await supabase
      .from("voucher_issuances")
      .update({ is_active: false, revoked_at: nowIso, revoke_reason: reason })
      .eq("id", issuanceId);
    if (revokeUpdateErr) {
      return NextResponse.json({ error: revokeUpdateErr.message }, { status: 500 });
    }

    // Step 4: issue exactly one new voucher — same duration derivation
    // (bookingWindowHours + 60min buffer) and quota as the issue route.
    const durationHours = bookingWindowHours(booking.start_time, booking.end_time);
    const durationMinutes = Math.ceil(durationHours * 60) + 60;

    let unifiId: string;
    let unifiCode: string;
    try {
      const result = await createUnifiVoucher(
        { durationMinutes, note: `booking_${id}_seat${issuance.seat_number}_replacement`, quota: 2 },
        siteConfig
      );
      unifiId = result.id;
      unifiCode = result.code;
    } catch (err) {
      console.error(`[booking-voucher-replace] Unifi create (replacement) failed:`, err);
      return NextResponse.json(
        {
          error:
            "The old voucher was revoked, but creating the replacement voucher on the UniFi controller failed. Issue a new voucher manually.",
        },
        { status: 502 }
      );
    }

    const { data: newRow, error: insertErr } = await supabase
      .from("voucher_issuances")
      .insert({
        contract_id: booking.contract_id || null,
        voucher_id: null,
        lead_id: issuance.lead_id || booking.lead_id || null,
        booking_id: id,
        seat_number: issuance.seat_number,
        issued_by: dbUser.id,
        issued_at: nowIso,
        valid_from: booking.booking_date,
        valid_until: booking.booking_date,
        is_active: true,
        seat_occupant_email: issuance.seat_occupant_email || null,
        unifi_voucher_id: unifiId,
        unifi_code: unifiCode,
        duration_minutes: durationMinutes,
        replaces_issuance_id: issuanceId,
      })
      .select("id")
      .single();
    if (insertErr || !newRow) {
      return NextResponse.json(
        { error: insertErr?.message || "Failed to record the replacement voucher" },
        { status: 500 }
      );
    }
    newIssuanceId = newRow.id;
  } else if (issuance.voucher_id) {
    // ──────────────────────────────────────────────────────────────
    // REPOSITORY PATH — reserve a replacement BEFORE touching the old
    // voucher, so an empty pool leaves everything unchanged.
    // ──────────────────────────────────────────────────────────────
    const { data: oldVoucher } = await supabase
      .from("voucher_repository")
      .select("id, validity_days")
      .eq("id", issuance.voucher_id)
      .single();

    const durationHours = bookingWindowHours(booking.start_time, booking.end_time);
    const isShortBooking = durationHours <= 3;
    const preferredValidity = isShortBooking ? 0.125 : 1;
    const fallbackValidity = isShortBooking ? 1 : null;
    const bookingLocationId = booking.location_id;

    async function fetchOneVoucher(validity: number) {
      const { data } = await supabase
        .from("voucher_repository")
        .select("id, voucher_code, validity_days")
        .eq("status", "available")
        .eq("validity_days", validity)
        .eq("location_id", bookingLocationId)
        .limit(1);
      return data?.[0] ?? null;
    }

    let newVoucher =
      (await fetchOneVoucher(oldVoucher?.validity_days ?? preferredValidity)) ||
      (await fetchOneVoucher(preferredValidity));
    if (!newVoucher && fallbackValidity) {
      newVoucher = await fetchOneVoucher(fallbackValidity);
    }

    if (!newVoucher) {
      return NextResponse.json(
        { error: "No replacement vouchers available in stock for this location. Nothing was changed." },
        { status: 502 }
      );
    }

    const validityDays = Number(newVoucher.validity_days ?? 1);
    const expiryMs = validityDays < 1
      ? Math.round(validityDays * 24 * 60 * 60 * 1000)
      : 24 * 60 * 60 * 1000;

    // Step 2/3: revoke the old repository code + mark the old issuance inactive.
    const { error: repoRevokeErr } = await supabase
      .from("voucher_repository")
      .update({ status: "revoked" })
      .eq("id", issuance.voucher_id);
    if (repoRevokeErr) {
      return NextResponse.json({ error: repoRevokeErr.message }, { status: 500 });
    }
    const { error: revokeUpdateErr } = await supabase
      .from("voucher_issuances")
      .update({ is_active: false, revoked_at: nowIso, revoke_reason: reason })
      .eq("id", issuanceId);
    if (revokeUpdateErr) {
      return NextResponse.json({ error: revokeUpdateErr.message }, { status: 500 });
    }

    // Step 4: issue the reserved replacement.
    const { error: markIssuedErr } = await supabase
      .from("voucher_repository")
      .update({
        status: "issued",
        issued_at: nowIso,
        expires_at: new Date(now.getTime() + expiryMs).toISOString(),
      })
      .eq("id", newVoucher.id);
    if (markIssuedErr) {
      return NextResponse.json({ error: markIssuedErr.message }, { status: 500 });
    }

    const { data: newRow, error: insertErr } = await supabase
      .from("voucher_issuances")
      .insert({
        contract_id: booking.contract_id || null,
        voucher_id: newVoucher.id,
        lead_id: issuance.lead_id || booking.lead_id || null,
        booking_id: id,
        seat_number: issuance.seat_number,
        issued_by: dbUser.id,
        issued_at: nowIso,
        valid_from: booking.booking_date,
        valid_until: booking.booking_date,
        is_active: true,
        seat_occupant_email: issuance.seat_occupant_email || null,
        duration_minutes: Math.round(validityDays * 24 * 60),
        replaces_issuance_id: issuanceId,
      })
      .select("id")
      .single();
    if (insertErr || !newRow) {
      return NextResponse.json(
        { error: insertErr?.message || "Failed to record the replacement voucher" },
        { status: 500 }
      );
    }
    newIssuanceId = newRow.id;
  } else {
    // Legacy/unrecognized issuance shape — no known controller/repository
    // link to act on.
    return NextResponse.json(
      { error: "This voucher issuance has no recognized controller or repository link to replace." },
      { status: 400 }
    );
  }

  // Best-effort email of the new code — never fail the replace on delivery
  // failure, same as the issue route's tryAutoEmailVouchers. This also
  // stamps emailed_at on the new (now sole active) issuance.
  let emailed = false;
  try {
    const result = await sendBookingVoucherEmail(supabase, {
      bookingId: id,
      senderName: dbUser.full_name || "TWV Team",
      performedBy: dbUser.id,
    });
    emailed = result.ok;
  } catch (err) {
    console.error("[booking-voucher-replace] auto-email after replacement failed:", err);
  }

  // Never log the voucher code itself — only issuance ids + reason.
  logAudit(supabase, {
    entityType: "voucher",
    entityId: id,
    action: "replace",
    performedBy: dbUser.id,
    changes: {
      old_issuance_id: { old: null, new: issuanceId },
      new_issuance_id: { old: null, new: newIssuanceId },
      reason: { old: null, new: reason },
    },
  });

  const { count: activeCount } = await supabase
    .from("voucher_issuances")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", id)
    .eq("is_active", true);
  const alreadyIssued = activeCount ?? 0;

  const { data: spaceForCap } = booking.space_id
    ? await supabase.from("spaces").select("capacity").eq("id", booking.space_id).single()
    : { data: null };
  const seatCap = computeVoucherSeatCap(booking, spaceForCap);

  return NextResponse.json({
    revoked_issuance_id: issuanceId,
    new_issuance_id: newIssuanceId,
    emailed,
    seat_cap: seatCap,
    already_issued: alreadyIssued,
    remaining: Math.max(0, seatCap - alreadyIssued),
  });
}
