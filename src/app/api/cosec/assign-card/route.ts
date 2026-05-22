import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { readCardFromDevice, setCardNumber } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

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
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();

  const { data: au } = await admin
    .from("cosec_access_users")
    .select("*, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("id", parsed.data.access_user_id)
    .single();

  if (!au) return NextResponse.json({ error: "Access user not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = au.device as any;
  if (!dev) return NextResponse.json({ error: "Device not found" }, { status: 404 });

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

  // Assign card to the user on the device
  await setCardNumber(deviceConn, au.cosec_user_id, cardNumber);

  // Persist in DB
  const now = new Date().toISOString();
  const currentStatus = au.enrollment_status as string;
  const newStatus = currentStatus === "biometric_enrolled" || currentStatus === "fully_enrolled"
    ? "fully_enrolled"
    : "card_enrolled";

  await admin
    .from("cosec_access_users")
    .update({
      nfc_card_number: cardNumber,
      enrollment_status: newStatus,
      card_enrolled_at: now,
      updated_at: now,
    })
    .eq("id", au.id);

  // Audit trail
  logAudit(admin, {
    entityType: "cosec_access_user",
    entityId: au.id,
    action: "update",
    performedBy: user.id,
    changes: {
      nfc_card_number: { old: au.nfc_card_number ?? null, new: cardNumber },
      enrollment_status: { old: currentStatus, new: newStatus },
    },
  });

  return NextResponse.json({ ok: true, cardNumber, cardType: cardResult.cardType, enrollment_status: newStatus });
}
