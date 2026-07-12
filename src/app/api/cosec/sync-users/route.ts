/**
 * POST /api/cosec/sync-users
 *
 * For a given device, fetches the name and card details from the COSEC device
 * for every cosec_ref_id seen in access_logs. Upserts results into
 * cosec_device_users (the name cache), then backfills access_logs.entity_name
 * for any rows that still have a null/empty entity_name.
 *
 * Called from the "Sync Users" button on the device detail page and from the
 * polling cron for new ref IDs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({ device_id: z.string().uuid() });

// Parse a single XML field value from a COSEC response string
function xmlValue(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

async function fetchUserFromDevice(
  ip: string,
  port: number,
  password: string,
  refId: number
): Promise<{ cosec_user_id: string; name: string | null; nfc_card: string | null; has_pin: boolean; is_active: boolean } | null> {
  try {
    const auth = Buffer.from(`admin:${password}`).toString("base64");
    const url = `http://${ip}:${port}/device.cgi/users?action=get&ref-user-id=${refId}&format=xml`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    // Response-Code 13 = user not found
    if (text.includes("<Response-Code>13</Response-Code>")) return null;
    const userId = xmlValue(text, "user-id");
    if (!userId) return null;
    const name = xmlValue(text, "name");
    const card = xmlValue(text, "card1");
    const pin = xmlValue(text, "user-pin");
    const active = xmlValue(text, "user-active");
    return {
      cosec_user_id: userId,
      name: name || null,
      nfc_card: card && card !== "0" ? card : null,
      has_pin: !!(pin && pin.length > 0),
      is_active: active === "1",
    };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();
  const { device_id } = parsed.data;

  // Load device credentials
  const { data: device, error: devErr } = await admin
    .from("cosec_devices")
    .select("device_ip, device_port, device_password")
    .eq("id", device_id)
    .single();
  if (devErr || !device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // Collect all unique ref IDs seen in logs for this device
  const { data: logRefs } = await admin
    .from("access_logs")
    .select("cosec_ref_id")
    .eq("device_id", device_id)
    .not("cosec_ref_id", "is", null);

  const uniqueRefs = [...new Set((logRefs ?? []).map((r: { cosec_ref_id: number }) => r.cosec_ref_id))];

  let synced = 0;
  let notFound = 0;
  const nameMap: Record<number, string> = {};

  // Fetch each ref ID from the device (sequential to avoid hammering the device)
  for (const refId of uniqueRefs) {
    const info = await fetchUserFromDevice(
      device.device_ip,
      device.device_port,
      device.device_password,
      refId
    );

    if (!info) {
      notFound++;
      continue;
    }

    // Upsert into cache table
    await admin.from("cosec_device_users").upsert(
      {
        device_id,
        cosec_ref_id: refId,
        cosec_user_id: info.cosec_user_id,
        name: info.name,
        nfc_card: info.nfc_card,
        has_pin: info.has_pin,
        is_active: info.is_active,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "device_id,cosec_ref_id" }
    );

    if (info.name) nameMap[refId] = info.name;
    synced++;
  }

  // Backfill access_logs.entity_name for any rows that still have no name
  // (only for rows where the name comes from the device cache, not CRM)
  for (const [refIdStr, name] of Object.entries(nameMap)) {
    const refId = Number(refIdStr);
    await admin
      .from("access_logs")
      .update({ entity_name: name })
      .eq("device_id", device_id)
      .eq("cosec_ref_id", refId)
      .or("entity_name.is.null,entity_name.eq.,entity_name.like.Ref #%");
  }

  return NextResponse.json({
    ok: true,
    total: uniqueRefs.length,
    synced,
    notFound,
    namesResolved: Object.keys(nameMap).length,
  });
}
