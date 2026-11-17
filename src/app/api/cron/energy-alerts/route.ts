import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { appUrl } from "@/lib/energy-alerts/auth";
import { evaluateAllRules } from "@/lib/energy-alerts/evaluate";

// Hourly, a few minutes after the ledger capture (which is what pulls new readings from
// OneGrid). Judges each enabled rule's new 15-minute slots and records / emails what the
// engine decides. Staff only; never contacts a customer.
//
// MODE (app_settings.energy_alerts_cron_mode): off | dry_run (default) | live. Only 'live'
// AND a rule set to Live can send an email. ?dry=1 computes and writes nothing at all.
export const maxDuration = 60;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dry = request.nextUrl.searchParams.get("dry") === "1";
    const { mode, rules } = await evaluateAllRules(createAdminClient(), { dry, appUrl: appUrl() });
    const failed = rules.filter((r) => r.error);
    return NextResponse.json({ mode, dry, rules, failed: failed.length }, { status: failed.length > 0 ? 502 : 200 });
  } catch (err) {
    console.error("[energy-alerts] run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Energy alert run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/energy-alerts", handler);
