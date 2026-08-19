/**
 * POST /api/bookings/[id]/vouchers/[issuanceId]/revoke
 *
 * Revokes a single active WiFi voucher issuance on a booking, freeing up a
 * seat under the cap enforced in POST /api/bookings/[id]/vouchers (see
 * computeVoucherSeatCap in src/lib/booking-vouchers.ts).
 *
 * Body (optional): { reason?: string }
 *
 * Per-mode behaviour:
 *   - UniFi: the code is actually deleted on the controller via
 *     revokeUnifiVoucher() before the issuance row is touched.
 *   - Ruijie: there is NO revoke endpoint on the Ruijie Cloud API (see
 *     src/lib/ruijie.ts header comment — this is a documented, permanent
 *     gap, not a TODO). Revoking here would silently mark the code inactive
 *     in the CRM while it keeps working on the controller — that would lie
 *     to staff about whether the customer's internet was cut. So this mode
 *     returns 501 and changes nothing.
 *   - Repository: no controller involved. The issuance is marked inactive
 *     and the underlying voucher_repository row is marked "revoked" (NOT
 *     returned to "available") — this matches how every other revoke path
 *     in the codebase treats a spent repository code: booking cancellation
 *     (src/lib/booking-cancel.ts) and contract voucher replacement
 *     (src/app/api/contracts/[id]/vouchers/[issuanceId]/replace/route.ts)
 *     both set status: "revoked", never "available". A code that was handed
 *     out is treated as burned even if it turns out to be unused, since the
 *     CRM has no way to know whether the customer already saw/used it.
 *
 * The issuance row is only updated after the controller call (where one
 * exists) succeeds — a failed controller call must never be reported to
 * staff as a successful revoke.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { revokeUnifiVoucher, siteConfigFromLocation, isUnifiLocation } from "@/lib/unifi";

const revokeBodySchema = z.object({
  reason: z.string().trim().min(1).optional(),
});

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
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const rawBody = await request.json().catch(() => ({}));
  const parsedBody = revokeBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }
  const { reason } = parsedBody.data;

  // Fetch the issuance and validate it belongs to this booking.
  const { data: issuance, error: issuanceErr } = await supabase
    .from("voucher_issuances")
    .select("id, booking_id, is_active, voucher_id, unifi_voucher_id, ruijie_voucher_uuid")
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
  // RUIJIE: no revoke capability on the controller. Refuse rather than
  // pretend — see module doc above and src/lib/ruijie.ts.
  // ──────────────────────────────────────────────────────────────────
  if (issuance.ruijie_voucher_uuid) {
    return NextResponse.json(
      {
        error:
          "Ruijie voucher revocation is not supported yet — the Ruijie Cloud API has no revoke endpoint. The code will remain active on the controller until it naturally expires.",
      },
      { status: 501 }
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // UNIFI: kill the code on the controller first.
  // ──────────────────────────────────────────────────────────────────
  if (issuance.unifi_voucher_id) {
    const { data: booking } = await supabase
      .from("bookings")
      .select("location_id")
      .eq("id", id)
      .single();

    const { data: location } = booking?.location_id
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
    try {
      // revokeUnifiVoucher is intentionally best-effort at the HTTP-client
      // level (it logs and swallows controller errors — e.g. a voucher
      // already deleted on the controller — rather than throwing, per its
      // own doc comment in src/lib/unifi.ts). We still wrap it so a genuine
      // thrown error (network/config failure before the request) produces
      // a 502 and leaves the issuance row untouched, matching the "never
      // claim a revoke that didn't happen" rule.
      await revokeUnifiVoucher(issuance.unifi_voucher_id, siteConfig);
    } catch (err) {
      console.error(`[booking-voucher-revoke] Unifi revoke ${issuance.unifi_voucher_id} failed:`, err);
      return NextResponse.json(
        { error: "Failed to revoke the voucher on the UniFi controller. The voucher was not marked inactive." },
        { status: 502 }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Repository mode (voucher_id set, no controller involved): mark the
  // pooled code "revoked", matching every other revoke path in the
  // codebase (see module doc above) — never returned to "available".
  // ──────────────────────────────────────────────────────────────────
  if (issuance.voucher_id) {
    const { error: repoErr } = await supabase
      .from("voucher_repository")
      .update({ status: "revoked" })
      .eq("id", issuance.voucher_id);
    if (repoErr) {
      console.error("[booking-voucher-revoke] voucher_repository update failed:", repoErr);
      return NextResponse.json({ error: repoErr.message }, { status: 500 });
    }
  }

  // Only now — after the controller call (if any) succeeded — update the
  // issuance row.
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("voucher_issuances")
    .update({ is_active: false, revoked_at: now, revoke_reason: reason ?? null })
    .eq("id", issuanceId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Never log the voucher code itself — only the issuance id + reason.
  logAudit(supabase, {
    entityType: "voucher",
    entityId: id,
    action: "revoke",
    performedBy: dbUser.id,
    changes: {
      issuance_id: { old: null, new: issuanceId },
      reason: { old: null, new: reason ?? null },
    },
  });

  return NextResponse.json({ ok: true, issuance_id: issuanceId, revoked_at: now });
}
