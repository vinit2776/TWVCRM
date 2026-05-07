/**
 * ADMS getrequest endpoint — device polls here for commands from server.
 *
 * During the test phase we return no commands (just "OK").
 * In the full build this will return commands like:
 *   - DATA UPDATE USERINFO PIN=5;Name=Vinit;...   (add/update user)
 *   - DATA DELETE USERINFO PIN=5                  (remove user)
 *   - DATA QUERY ATTLOG StartTime=...             (request records)
 *   - REBOOT                                      (restart device)
 *
 * The device calls:  GET /iclock/getrequest?SN=<serial>
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const serial = req.nextUrl.searchParams.get("SN") ?? "UNKNOWN";
  const ip     = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  // Keep the device heartbeat fresh
  const supabase = await createAdminClient();
  await supabase
    .from("biometric_devices")
    .update({ last_seen_at: new Date().toISOString(), last_ip: ip, updated_at: new Date().toISOString() })
    .eq("serial_number", serial);

  console.info(`[biometric] GET getrequest  serial=${serial}`);

  // No pending commands — device will check again on next poll interval
  return new NextResponse("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
