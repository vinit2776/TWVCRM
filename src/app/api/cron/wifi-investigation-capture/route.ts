import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAllInvestigation } from "@/lib/wifi-investigation-capture";
import { withCronHealth } from "@/lib/cron-ping";

// Hourly at :32, after the usage capture at :17. Copies each UniFi center's Wi-Fi
// sessions, device-to-person assignments and public IP into our own records
// (migration 00744) before the console ages them out. Does nothing until
// app_settings.wifi_investigation_enabled is 'true'. Read-only against UniFi;
// writes only the investigation tables; sends nothing to anyone.
//
// It has its own run, and a time budget shared between centers, because the first
// run for a center is a 30 day back-fill: sharing the usage capture's 60 seconds
// timed that run out. The session read stops at its share and the next run carries on
// from the newest stored session.
export const maxDuration = 60;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await captureAllInvestigation(createAdminClient());
    // Counts and part names only: no MACs, IPs or names reach the logs.
    for (const l of result.locations) console.log("[wifi-investigation-capture]", JSON.stringify(l));
    const failed = result.locations.filter((l) => l.failed_parts.length > 0);
    // Non-2xx so cron_health records "error": a rejected key or an unreachable console must not look healthy.
    return NextResponse.json(result, { status: failed.length > 0 ? 502 : 200 });
  } catch (err) {
    console.error("[wifi-investigation-capture] run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Capture run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/wifi-investigation-capture", handler);
