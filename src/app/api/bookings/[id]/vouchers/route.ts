/**
 * POST /api/bookings/[id]/vouchers
 *
 * On-demand WiFi voucher issuance for ANY booking type. Staff click
 * "Issue Vouchers" on the booking detail page and choose how many
 * codes to issue (defaults to ceil(num_attendees / 2)).
 *
 * Body (optional):
 *   { count?: number }  — how many vouchers to issue (1–20).
 *                          Defaults to ceil(num_attendees / 2) or 1.
 *
 * Design rationale:
 *   - Vouchers are no longer auto-issued at booking creation time.
 *   - Staff decides the count based on actual attendees (an 8-seat room
 *     with 2 people only needs 1 code, not 4).
 *   - Already-issued vouchers are additive — calling again issues MORE,
 *     it doesn't re-issue. This lets staff top-up if more guests arrive.
 *   - DB calls are batched: parallel repo updates + single bulk insert.
 *
 * For Unifi locations (wifi_voucher_mode = 'unifi_api'):
 *   - Vouchers are generated on-demand via the Unifi cloud API.
 *   - Duration = booking duration in minutes + 60-minute buffer.
 *   - Each voucher has quota=2 (2 devices).
 *   - unifi_voucher_id is stored on the issuance row for revocation.
 *
 * For Ruijie locations (wifi_voucher_mode = 'ruijie_api', e.g. Nungambakkam
 * Arcade): vouchers are generated on-demand via the Ruijie Cloud API,
 * matched to the closest CRM_ package by duration (see src/lib/ruijie.ts).
 * Ruijie can't do exact-minute durations like Unifi — very short bookings
 * (hours) will fail with a clear error until IT creates short-duration
 * CRM_ packages; this is expected, not a bug.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { bookingWindowHours } from "@/lib/utils";
import { sendBookingVoucherEmail, computeVoucherSeatCap } from "@/lib/booking-vouchers";
import {
  createUnifiVoucher,
  siteConfigFromLocation,
  isUnifiLocation,
} from "@/lib/unifi";
import {
  siteConfigFromLocation as ruijieSiteConfigFromLocation,
  isRuijieLocation,
  issueRuijieVoucher,
} from "@/lib/ruijie";

const voucherIssueBodySchema = z.object({
  count: z.number().finite().optional(),
  /**
   * Only honored when the caller's role is admin — anyone else who sends a
   * non-empty override_reason gets a 403 (see role check below). Lets an
   * admin push past the seat cap for a legitimate exception, with an
   * audited reason.
   */
  override_reason: z.string().trim().min(1).optional(),
});

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Best-effort auto-send of freshly-issued codes to the customer. A delivery
 * failure must never fail or roll back the issuance itself (bug: staff used
 * to have to remember a separate "Send to customer" click, and when they
 * forgot, the code silently never reached the customer).
 */
async function tryAutoEmailVouchers(
  supabase: SupabaseServerClient,
  bookingId: string,
  senderName: string,
  performedBy: string
): Promise<boolean> {
  try {
    const result = await sendBookingVoucherEmail(supabase, {
      bookingId,
      senderName,
      performedBy,
    });
    return result.ok;
  } catch (err) {
    console.error("[booking-vouchers] auto-email after issuance failed:", err);
    return false;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Fetch booking
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, booking_date, customer_type, num_attendees, location_id, space_id, lead_id, contract_id, guest_email, duration_hours, start_time, end_time, status, quantity, pricing_model")
    .eq("id", id)
    .single();

  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const bk = booking;

  if (!["confirmed", "checked_in"].includes(bk.status)) {
    return NextResponse.json(
      { error: "Vouchers can only be issued for confirmed or checked-in bookings" },
      { status: 400 }
    );
  }

  // Parse and validate the request body
  const rawBody = await request.json().catch(() => ({}));
  const parsedBody = voucherIssueBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }
  const { count, override_reason } = parsedBody.data;

  // override_reason is admin-only. Anyone else sending it gets a hard 403 —
  // this is a privileged bypass of the seat cap, not a general "reason" field.
  if (override_reason && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins may override the voucher seat cap" },
      { status: 403 }
    );
  }
  const isOverride = !!override_reason && dbUser.role === "admin";

  const numAttendeesInt = bk.num_attendees ? Math.max(1, Number(bk.num_attendees)) : 1;
  const defaultCount = Math.ceil(numAttendeesInt / 2);
  const requestedCount = count != null ? Math.max(1, Math.min(20, Math.floor(count))) : defaultCount;

  // Count already-issued vouchers to set correct seat numbers
  const { data: existing } = await supabase
    .from("voucher_issuances")
    .select("id")
    .eq("booking_id", id)
    .eq("is_active", true);
  const alreadyIssued = existing?.length ?? 0;

  // Seat cap: daily-priced spaces cap on seats purchased (quantity), other
  // pricing models cap on the space's capacity. See computeVoucherSeatCap.
  const { data: spaceForCap } = bk.space_id
    ? await supabase.from("spaces").select("capacity").eq("id", bk.space_id).single()
    : { data: null };
  const seatCap = computeVoucherSeatCap(bk, spaceForCap);
  const remaining = Math.max(0, seatCap - alreadyIssued);

  if (!isOverride && alreadyIssued + requestedCount > seatCap) {
    return NextResponse.json(
      {
        error: `This booking has ${alreadyIssued} of ${seatCap} seats' vouchers issued. Revoke one before issuing another, or increase the booking's seats.`,
        seat_cap: seatCap,
        already_issued: alreadyIssued,
        remaining,
      },
      { status: 422 }
    );
  }

  if (isOverride) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "cap_override",
      performedBy: dbUser.id,
      changes: {
        reason: { old: null, new: override_reason },
        seat_cap: { old: null, new: seatCap },
        already_issued: { old: null, new: alreadyIssued },
        requested_count: { old: null, new: requestedCount },
        resulting_count: { old: null, new: alreadyIssued + requestedCount },
      },
    });
  }

  // Fetch location to determine voucher mode
  const { data: location } = bk.location_id
    ? await supabase
        .from("locations")
        .select("unifi_site_id, unifi_console_id, wifi_voucher_mode, ruijie_group_id")
        .eq("id", bk.location_id)
        .single()
    : { data: null };

  // ──────────────────────────────────────────────────────────────────
  // UNIFI PATH
  // ──────────────────────────────────────────────────────────────────
  if (location && isUnifiLocation(location)) {
    const siteConfig = siteConfigFromLocation(location);
    // bk.duration_hours is a billing quantity (for daily-priced spaces it is
    // "1" meaning one day unit, NOT one hour) — never read it as a wall-clock
    // duration. Derive the real booking window from start_time/end_time.
    const durationHours = bookingWindowHours(bk.start_time, bk.end_time);
    // Duration = booking window in minutes + 60-minute buffer
    const durationMinutes = Math.ceil(durationHours * 60) + 60;

    const now = new Date();
    const issuances = [];
    const codes: string[] = [];

    for (let i = 0; i < requestedCount; i++) {
      const seatNumber = alreadyIssued + i + 1;
      let unifiId: string;
      let unifiCode: string;

      try {
        const result = await createUnifiVoucher(
          {
            durationMinutes,
            note: `booking_${id}_seat${seatNumber}`,
            quota: 2,
          },
          siteConfig
        );
        unifiId = result.id;
        unifiCode = result.code;
      } catch (err) {
        console.error(`[unifi] booking voucher seat ${seatNumber} failed:`, err);
        return NextResponse.json(
          { error: `Failed to create Unifi voucher. ${i} vouchers issued before failure.` },
          { status: 502 }
        );
      }

      const { error: insertError } = await supabase.from("voucher_issuances").insert({
        contract_id: bk.contract_id || null,
        voucher_id: null,
        lead_id: bk.lead_id || null,
        booking_id: id,
        seat_number: seatNumber,
        issued_by: dbUser.id,
        issued_at: now.toISOString(),
        valid_from: bk.booking_date,
        valid_until: bk.booking_date,
        is_active: true,
        seat_occupant_email: i === 0 && alreadyIssued === 0 ? (bk.guest_email || null) : null,
        unifi_voucher_id: unifiId,
        unifi_code: unifiCode,
        duration_minutes: durationMinutes,
      });

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      issuances.push({ seat_number: seatNumber, unifi_voucher_id: unifiId, code: unifiCode });
      codes.push(unifiCode);
    }

    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        booking_id: { old: null, new: id },
        mode: { old: null, new: "unifi_api" },
        count: { old: null, new: issuances.length },
        duration_minutes: { old: null, new: durationMinutes },
        unifi_codes: { old: null, new: codes },
      },
    });

    const emailed = issuances.length > 0
      ? await tryAutoEmailVouchers(supabase, id, dbUser.full_name || "TWV Team", dbUser.id)
      : false;

    return NextResponse.json({
      issued: issuances.length,
      needed: requestedCount,
      shortfall: 0,
      codes,
      total_issued: alreadyIssued + issuances.length,
      seat_cap: seatCap,
      already_issued: alreadyIssued + issuances.length,
      remaining: Math.max(0, seatCap - (alreadyIssued + issuances.length)),
      emailed,
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // RUIJIE PATH
  // ──────────────────────────────────────────────────────────────────
  if (location && isRuijieLocation(location)) {
    const siteConfig = ruijieSiteConfigFromLocation(location);
    if (!siteConfig) {
      return NextResponse.json(
        { error: "This location is set to Ruijie voucher mode but has no ruijie_group_id configured." },
        { status: 400 }
      );
    }

    // bk.duration_hours is a billing quantity, not a wall-clock duration —
    // see the Unifi path above. Derive the real window from start/end time.
    const durationHours = bookingWindowHours(bk.start_time, bk.end_time);
    const targetDays = durationHours / 24;

    const now = new Date();
    const issuances = [];
    const codes: string[] = [];
    let lastMatchWarning: string | null = null;

    for (let i = 0; i < requestedCount; i++) {
      const seatNumber = alreadyIssued + i + 1;

      const issued = await issueRuijieVoucher(
        siteConfig,
        targetDays,
        `booking_${id}_seat${seatNumber}`
      );

      if ("error" in issued) {
        return NextResponse.json(
          { error: `${issued.error} ${issuances.length} vouchers issued before failure.` },
          { status: 400 }
        );
      }

      // Ruijie matches to the closest CRM_ package, so the granted validity
      // can differ from the requested window — derive duration_minutes from
      // the voucher's own issued/expiry timestamps rather than the request.
      const ruijieDurationMs = new Date(issued.result.expiryTime).getTime() - now.getTime();
      const ruijieDurationMinutes = Number.isFinite(ruijieDurationMs) && ruijieDurationMs > 0
        ? Math.round(ruijieDurationMs / 60000)
        : Math.round(targetDays * 24 * 60);

      const { error: insertError } = await supabase.from("voucher_issuances").insert({
        contract_id: bk.contract_id || null,
        voucher_id: null,
        lead_id: bk.lead_id || null,
        booking_id: id,
        seat_number: seatNumber,
        issued_by: dbUser.id,
        issued_at: now.toISOString(),
        valid_from: bk.booking_date,
        valid_until: bk.booking_date,
        is_active: true,
        seat_occupant_email: i === 0 && alreadyIssued === 0 ? (bk.guest_email || null) : null,
        ruijie_voucher_uuid: issued.result.uuid,
        ruijie_code: issued.result.code,
        duration_minutes: ruijieDurationMinutes,
      });

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      issuances.push({ seat_number: seatNumber, ruijie_voucher_uuid: issued.result.uuid, code: issued.result.code });
      codes.push(issued.result.code);
      lastMatchWarning = issued.matchWarning;
    }

    logAudit(supabase, {
      entityType: "voucher",
      entityId: id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        booking_id: { old: null, new: id },
        mode: { old: null, new: "ruijie_api" },
        count: { old: null, new: issuances.length },
        ruijie_codes: { old: null, new: codes },
      },
    });

    const emailed = issuances.length > 0
      ? await tryAutoEmailVouchers(supabase, id, dbUser.full_name || "TWV Team", dbUser.id)
      : false;

    return NextResponse.json({
      issued: issuances.length,
      needed: requestedCount,
      shortfall: 0,
      codes,
      total_issued: alreadyIssued + issuances.length,
      seat_cap: seatCap,
      already_issued: alreadyIssued + issuances.length,
      remaining: Math.max(0, seatCap - (alreadyIssued + issuances.length)),
      match_warning: lastMatchWarning,
      emailed,
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // REPOSITORY PATH (existing logic)
  // ──────────────────────────────────────────────────────────────────

  // bk.duration_hours is a billing quantity, not a wall-clock duration —
  // see the Unifi path above. Derive the real window from start/end time.
  const durationHours = bookingWindowHours(bk.start_time, bk.end_time);
  const isShortBooking = durationHours <= 3;
  const preferredValidity = isShortBooking ? 0.125 : 1;
  const fallbackValidity  = isShortBooking ? 1     : null;

  async function fetchVouchers(validity: number, limit: number) {
    const { data } = await supabase
      .from("voucher_repository")
      .select("id, voucher_code, validity_days")
      .eq("status", "available")
      .eq("validity_days", validity)
      .eq("location_id", bk.location_id)
      .limit(limit);
    return data || [];
  }

  let vouchers = await fetchVouchers(preferredValidity, requestedCount);
  if (vouchers.length < requestedCount && fallbackValidity) {
    const stillNeeded = requestedCount - vouchers.length;
    vouchers = [...vouchers, ...(await fetchVouchers(fallbackValidity, stillNeeded))];
  }

  if (vouchers.length === 0) {
    return NextResponse.json(
      { error: "No vouchers available in stock for this location. Please top up the voucher inventory." },
      { status: 422 }
    );
  }

  const now = new Date();

  // Batch: parallel repo updates + single bulk issuance insert
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: PromiseLike<any>[] = [
    // Update each voucher's status in parallel
    ...vouchers.map((v) => {
      const validityDays = Number(v.validity_days ?? 1);
      const expiryMs = validityDays < 1
        ? Math.round(validityDays * 24 * 60 * 60 * 1000)
        : 24 * 60 * 60 * 1000;
      return supabase.from("voucher_repository").update({
        status: "issued",
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + expiryMs).toISOString(),
      }).eq("id", v.id);
    }),
    // Single bulk insert for all issuances
    supabase.from("voucher_issuances").insert(
      vouchers.map((v, i) => ({
        contract_id: bk.contract_id || null,
        voucher_id: v.id,
        lead_id: bk.lead_id || null,
        booking_id: id,
        seat_number: alreadyIssued + i + 1,
        issued_by: dbUser.id,
        issued_at: now.toISOString(),
        valid_from: bk.booking_date,
        valid_until: bk.booking_date,
        is_active: true,
        seat_occupant_email: i === 0 && alreadyIssued === 0 ? (bk.guest_email || null) : null,
        // Repository vouchers carry a fixed validity_days set on the stock
        // itself (not derived from the requested window) — convert that to
        // minutes for the same duration_minutes column the other two modes use.
        duration_minutes: Math.round(Number(v.validity_days ?? 1) * 24 * 60),
      }))
    ),
  ];

  await Promise.all(ops);

  logAudit(supabase, {
    entityType: "voucher",
    entityId: id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      booking_id: { old: null, new: id },
      mode: { old: null, new: "repository" },
      count: { old: null, new: vouchers.length },
    },
  });

  const emailed = vouchers.length > 0
    ? await tryAutoEmailVouchers(supabase, id, dbUser.full_name || "TWV Team", dbUser.id)
    : false;

  return NextResponse.json({
    issued: vouchers.length,
    needed: requestedCount,
    shortfall: Math.max(0, requestedCount - vouchers.length),
    codes: vouchers.map((v) => v.voucher_code),
    total_issued: alreadyIssued + vouchers.length,
    seat_cap: seatCap,
    already_issued: alreadyIssued + vouchers.length,
    remaining: Math.max(0, seatCap - (alreadyIssued + vouchers.length)),
    emailed,
  });
}
