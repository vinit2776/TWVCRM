import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { readCardFromDevice, setCardNumber, refreshUserValidity } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

// Allow up to 30 seconds — the card read polls the device for 20s
export const maxDuration = 30;

const schema = z.object({
  access_user_id: z.string().uuid(),
});

/**
 * POST /api/cosec/assign-card
 *
 * Triggers the physical card reader on the device for up to 20 seconds,
 * reads the card CSN, updates the COSEC user record (card1=CSN), and
 * persists the card number in cosec_access_users.
 *
 * The client should show a "Tap card now..." state while this request is pending.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();

  const { data: au } = await admin
    .from("cosec_access_users")
    .select("*, device:cosec_devices(device_ip, device_port, device_password, location_id)")
    .eq("id", parsed.data.access_user_id)
    .single();

  if (!au) return NextResponse.json({ error: "Access user not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = au.device as any;
  if (!dev) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // location_id of the device being enrolled — propagation is scoped to this location only
  const enrolledLocationId: string | null = dev.location_id ?? null;

  const deviceConn = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  // Block up to 20s waiting for physical card tap
  let cardResult: { cardNumber: string; cardType: string };
  try {
    cardResult = await readCardFromDevice(deviceConn);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No card detected. Tap card on the device reader." },
      { status: 408 }
    );
  }

  const { cardNumber } = cardResult;

  // ── Resolve the contract's current valid_until ─────────────────────────────
  // We need the LIVE contract expiry (not the stale value stored when provisioned)
  // so we can re-activate expired users as part of card enrollment.
  let freshValidUntil: Date | null = null;
  try {
    if (au.user_type === "member") {
      // member → contract_members → contracts.valid_until
      const { data: cm } = await admin
        .from("contract_members")
        .select("contract_id")
        .eq("id", au.entity_id)
        .single();
      if (cm?.contract_id) {
        const { data: contract } = await admin
          .from("contracts")
          .select("valid_until")
          .eq("id", cm.contract_id)
          .single();
        freshValidUntil = contract?.valid_until ? new Date(contract.valid_until) : null;
      }
    } else if (au.user_type === "contract") {
      // entity_id IS the contract id
      const { data: contract } = await admin
        .from("contracts")
        .select("valid_until")
        .eq("id", au.entity_id)
        .single();
      freshValidUntil = contract?.valid_until ? new Date(contract.valid_until) : null;
    }
    // bookings have their own valid window — don't touch validity during card enroll
  } catch { /* non-fatal — use null (no expiry) as safe fallback */ }

  // ── Fetch access users for this entity — same location only ───────────────
  // Propagation is intentionally scoped to the location of the device being
  // enrolled. A member may have access at multiple branches; we must not push
  // this location's card enrollment to another branch's devices.
  let locationDeviceIds: string[] = [au.device_id as string];
  if (enrolledLocationId) {
    const { data: locationDevices } = await admin
      .from("cosec_devices")
      .select("id")
      .eq("location_id", enrolledLocationId);
    if (locationDevices && locationDevices.length > 0) {
      locationDeviceIds = locationDevices.map(d => d.id);
    }
  }

  const { data: allAccessUsers } = await admin
    .from("cosec_access_users")
    .select("id, cosec_user_id, enrollment_status, nfc_card_number, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("entity_id", au.entity_id)
    .eq("user_type", au.user_type)
    .in("device_id", locationDeviceIds);

  const allUsers = allAccessUsers ?? [au];
  const now = new Date().toISOString();

  // ── Push card + refreshed validity to every device in parallel ─────────────
  await Promise.allSettled(allUsers.map(async (accessUser) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = accessUser.device as any;
    if (!d) return;
    const conn = { ip: d.device_ip, port: d.device_port, password: d.device_password };
    const cosecUserId = accessUser.cosec_user_id as string;

    // Set the card number (non-fatal per device)
    try { await setCardNumber(conn, cosecUserId, cardNumber); } catch { /* skip */ }

    // Re-activate user and push fresh validity (non-fatal per device)
    try { await refreshUserValidity(conn, cosecUserId, freshValidUntil); } catch { /* skip */ }
  }));

  // ── Update all DB rows for this entity ─────────────────────────────────────
  await Promise.allSettled(allUsers.map(async (accessUser) => {
    const currentStatus = accessUser.enrollment_status as string;
    const newStatus =
      currentStatus === "biometric_enrolled" || currentStatus === "fully_enrolled"
        ? "fully_enrolled"
        : "card_enrolled";

    await admin
      .from("cosec_access_users")
      .update({
        nfc_card_number: cardNumber,
        enrollment_status: newStatus,
        card_enrolled_at: now,
        valid_until: freshValidUntil?.toISOString() ?? null,
        updated_at: now,
      })
      .eq("id", accessUser.id);
  }));

  const currentStatus = au.enrollment_status as string;
  const newStatus =
    currentStatus === "biometric_enrolled" || currentStatus === "fully_enrolled"
      ? "fully_enrolled"
      : "card_enrolled";

  // Audit trail (primary device only — represents the enrollment event)
  logAudit(admin, {
    entityType: "cosec_access_user",
    entityId: au.id,
    action: "update",
    performedBy: user.id,
    changes: {
      nfc_card_number:  { old: au.nfc_card_number ?? null, new: cardNumber },
      enrollment_status: { old: currentStatus, new: newStatus },
      valid_until:       { old: au.valid_until ?? null, new: freshValidUntil?.toISOString() ?? null },
    },
  });

  return NextResponse.json({
    ok: true,
    cardNumber,
    cardType: cardResult.cardType,
    enrollment_status: newStatus,
    devices_updated: allUsers.length,
    valid_until: freshValidUntil?.toISOString() ?? null,
  });
}
