import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAllLocations } from "@/lib/energy-ledger-capture";
import { withCronHealth } from "@/lib/cron-ping";

// Hourly. Extends every OneGrid-enabled location's energy ledger from where it
// last stopped, so the usage baselines no longer depend on someone logging
// headcount. Read-only against OneGrid; writes only location_energy_readings.
export const maxDuration = 60;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { locations, skipped } = await captureAllLocations(createAdminClient());
    const failed = locations.filter((l) => l.status === "error");
    // Non-2xx so cron_health records "error" and /api/health surfaces it — an
    // OneGrid outage or a rejected key must not look like a healthy run.
    return NextResponse.json(
      { checked: locations.length, failed: failed.length, skipped, locations },
      { status: failed.length > 0 ? 502 : 200 }
    );
  } catch (err) {
    console.error("[energy-ledger-capture] run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Capture run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/energy-ledger-capture", handler);
