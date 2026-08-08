import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { readCardFromDevice, setCardNumber } from "@/lib/cosec";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  device_id: z.string().uuid(),
  // If provided, the card number will be immediately assigned to this COSEC user
  cosec_user_id: z.string().optional(),
  // The cosec_access_users row to update after successful scan
  access_user_id: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { device_id, cosec_user_id, access_user_id } = parsed.data;

  const admin = createAdminClient();
  const { data: deviceRow, error: deviceErr } = await admin
    .from("cosec_devices")
    .select("device_ip, device_port, device_password")
    .eq("id", device_id)
    .eq("is_enabled", true)
    .single();

  if (deviceErr || !deviceRow) {
    return NextResponse.json({ error: "Device not found or disabled" }, { status: 404 });
  }

  const device = {
    ip: deviceRow.device_ip,
    port: deviceRow.device_port,
    password: deviceRow.device_password,
  };

  // Read the card — blocks for up to 20s waiting for tap
  let cardResult: { cardNumber: string; cardType: string };
  try {
    cardResult = await readCardFromDevice(device);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Card read failed" },
      { status: 422 }
    );
  }

  // If a cosec_user_id was provided, push the card number to that user on device
  if (cosec_user_id) {
    try {
      await setCardNumber(device, cosec_user_id, cardResult.cardNumber);
    } catch (err) {
      return NextResponse.json(
        { error: `Card scanned (${cardResult.cardNumber}) but failed to assign to device user: ${err instanceof Error ? err.message : err}` },
        { status: 422 }
      );
    }
  }

  // Persist card number in cosec_access_users
  if (access_user_id) {
    await admin
      .from("cosec_access_users")
      .update({
        nfc_card_number: cardResult.cardNumber,
        card_enrolled_at: new Date().toISOString(),
        enrollment_status: "card_enrolled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", access_user_id);
  }

  return NextResponse.json({ cardNumber: cardResult.cardNumber, cardType: cardResult.cardType });
}
