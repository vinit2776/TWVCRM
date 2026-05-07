/**
 * ADMS / iClock endpoint — eSSL F22 / ZKTeco push receiver
 *
 * The biometric device is configured with:
 *   Server Address : twv-crm.vercel.app   (or your custom domain)
 *   Server Port    : 443
 *   HTTPS          : Yes
 *
 * Device calls:
 *   GET  /iclock/cdata?SN=<serial>&options=all  → server returns config
 *   POST /iclock/cdata?SN=<serial>&table=ATTLOG → device pushes punches
 *
 * ATTLOG line format (tab-separated):
 *   PIN  Time                 Status  Verify  WorkCode  Res1  Res2
 *   5    2026-05-07 09:15:00  0       1       0         0     0
 *
 * Status: 0=check-in 1=check-out 4=break-out 5=break-in
 * Verify: 0=pin 1=fingerprint 4=rfid-card 15=face
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// ── Helpers ──────────────────────────────────────────────────

function textReply(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Parse the IST timestamp the device sends (no timezone offset). */
function parseDeviceTime(raw: string): Date {
  // Format: "2026-05-07 09:15:00"
  const d = new Date(raw.replace(" ", "T") + "+05:30"); // IST
  return isNaN(d.getTime()) ? new Date() : d;
}

/** Upsert the device record so we always have its latest heartbeat. */
async function upsertDevice(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  serial: string,
  meta: { firmware?: string; pushver?: string; ip?: string }
) {
  await supabase
    .from("biometric_devices")
    .upsert(
      {
        serial_number:    serial,
        firmware_version: meta.firmware ?? null,
        push_version:     meta.pushver  ?? null,
        last_ip:          meta.ip       ?? null,
        last_seen_at:     new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      },
      { onConflict: "serial_number", ignoreDuplicates: false }
    );
}

// ── GET  /iclock/cdata  (device registration / heartbeat) ────

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const serial  = params.get("SN") ?? "UNKNOWN";
  const pushver = params.get("pushver") ?? "";
  const ip      = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  // Register / update device
  const supabase = await createAdminClient();
  await upsertDevice(supabase, serial, { pushver, ip });

  console.info(`[biometric] GET cdata  serial=${serial} ip=${ip}`);

  // Standard ADMS config response — device reads these settings
  const config = [
    `GET OPTION FROM: ${serial}`,
    `Stamp=9999`,          // device will send records after this stamp (9999 = send all)
    `OpStamp=9999`,
    `ErrorDelay=30`,       // seconds to wait before retrying on error
    `Delay=10`,            // polling interval (seconds)
    `TransTimes=00:00;23:59`, // allowed push window (all day)
    `TransInterval=1`,     // push interval (minutes)
    `TransFlag=TransData AttLog`,
    `Realtime=1`,          // push records in real-time (not just on schedule)
    `Encrypt=None`,
  ].join("\r\n");

  return textReply(config);
}

// ── POST /iclock/cdata  (attendance data push) ────────────────

export async function POST(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const serial  = params.get("SN") ?? "UNKNOWN";
  const table   = params.get("table") ?? "";
  const ip      = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  const supabase = await createAdminClient();
  await upsertDevice(supabase, serial, { ip });

  // We only process ATTLOG (attendance records).
  // Other tables (OPERLOG, BIODATA, etc.) are acknowledged but ignored for now.
  if (table !== "ATTLOG") {
    console.info(`[biometric] POST cdata  serial=${serial} table=${table} — ignored`);
    return textReply("OK: 0");
  }

  const body = await req.text();
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  console.info(`[biometric] POST ATTLOG  serial=${serial}  lines=${lines.length}`);

  const inserts = lines.map((line) => {
    // Fields are tab-separated: PIN Time Status Verify WorkCode Res1 Res2
    const parts = line.split("\t");
    const pin        = parts[0]?.trim() ?? "";
    const timeRaw    = parts[1]?.trim() ?? "";
    const status     = parseInt(parts[2] ?? "0", 10);
    const verify     = parseInt(parts[3] ?? "0", 10);
    const workCode   = parts[4]?.trim() ?? null;

    return {
      device_serial: serial,
      device_pin:    pin,
      punch_time:    parseDeviceTime(timeRaw).toISOString(),
      status_code:   isNaN(status) ? 0 : status,
      verify_type:   isNaN(verify) ? 0 : verify,
      work_code:     workCode || null,
      raw_line:      line,
    };
  });

  if (inserts.length > 0) {
    const { error } = await supabase
      .from("biometric_raw_punches")
      .insert(inserts);

    if (error) {
      console.error("[biometric] DB insert error:", error.message);
      return textReply("ERROR", 500);
    }
  }

  // Device expects "OK: <count>" to acknowledge receipt
  return textReply(`OK: ${inserts.length}`);
}
