import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAllWifi } from "@/lib/wifi-ledger-capture";
import { withCronHealth } from "@/lib/cron-ping";

// Hourly. Copies each UniFi-managed center's hourly Wi-Fi usage into our own
// ledger before the console ages it out (it keeps hourly figures for about 7
// days). Read-only against UniFi; writes only wifi_client_hourly and
// wifi_site_hourly; sends nothing to anyone.
export const maxDuration = 60;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { locations, skipped } = await captureAllWifi(createAdminClient());
    const failed = locations.filter((l) => l.status === "error");
    // Non-2xx so cron_health records "error": a rejected key or an unreachable
    // console must not look like a healthy run.
    return NextResponse.json(
      { checked: locations.length, failed: failed.length, skipped, locations },
      { status: failed.length > 0 ? 502 : 200 }
    );
  } catch (err) {
    console.error("[wifi-ledger-capture] run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Capture run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/wifi-ledger-capture", handler);
