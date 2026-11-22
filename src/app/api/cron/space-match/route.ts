import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { runSpaceMatch } from "@/lib/space-match-server";

/**
 * GET /api/cron/space-match
 *
 * Daily. Flags enquiries waiting for space that now fit free seats (same centre, a type that fits,
 * enough seats free from their start date for a month) and tells the person who parked them; a
 * flagged one that no longer fits goes back to waiting. It also runs right after contract-expiry
 * frees seats. Staff only, never messages a customer. Mode `space_match_mode`: off / dry_run
 * (default: reports, changes and sends nothing) / live. `?dry=1` forces a preview.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runSpaceMatch(createAdminClient(), { forceDry: request.nextUrl.searchParams.get("dry") === "1" });
  return NextResponse.json(result);
}

export const GET = withCronHealth("cron/space-match", handler);
