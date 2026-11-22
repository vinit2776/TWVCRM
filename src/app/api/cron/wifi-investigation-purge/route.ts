import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { purgeInvestigationRecords } from "@/lib/wifi-investigation-capture";
import { withCronHealth } from "@/lib/cron-ping";

// Daily. Deletes Wi-Fi sessions, closed device assignments and public-IP history
// older than the 12-month retention. Never touches wifi_investigation_log (the
// record of who looked at what). Runs whether or not capture is switched on:
// retention applies to whatever is stored. Sends nothing to anyone.
export const maxDuration = 60;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const purged = await purgeInvestigationRecords(createAdminClient());
    return NextResponse.json({ purged });
  } catch (err) {
    console.error("[wifi-investigation-purge] run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Purge failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/wifi-investigation-purge", handler);
