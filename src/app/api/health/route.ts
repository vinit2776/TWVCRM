import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Max allowed hours since last run before a cron is flagged as stale
const CRON_THRESHOLDS: Record<string, number> = {
  "petty-cash/day-book":    26, // daily — allow 2h grace
  "digest":                 26,
  "billing/auto-generate":  50, // monthly — check within 2 days after 1st
  "cron/db-backup":         26,
  "cron/storage-backup":    26,
};

// Public health check — used by UptimeRobot every minute
// Returns 200 if all systems ok, 503 if DB unreachable
export async function GET() {
  const start = Date.now();

  try {
    const supabase = await createClient();

    // Lightweight DB ping
    const { error: dbError } = await supabase
      .from("app_settings")
      .select("id")
      .limit(1);

    if (dbError) throw new Error(dbError.message);

    // Check cron staleness
    const { data: cronRows } = await supabase
      .from("cron_health")
      .select("job, last_run_at, last_status");

    const staleJobs: string[] = [];
    const cronStatus: Record<string, { last_run_at: string; hours_ago: number; status: string }> = {};

    for (const row of (cronRows ?? [])) {
      const hoursAgo = (Date.now() - new Date(row.last_run_at).getTime()) / 3_600_000;
      const threshold = CRON_THRESHOLDS[row.job] ?? 26;
      cronStatus[row.job] = {
        last_run_at: row.last_run_at,
        hours_ago: Math.round(hoursAgo * 10) / 10,
        status: row.last_status,
      };
      if (hoursAgo > threshold) staleJobs.push(row.job);
    }

    const latencyMs = Date.now() - start;
    const allOk = staleJobs.length === 0;

    return NextResponse.json(
      {
        status: allOk ? "ok" : "degraded",
        db: "connected",
        latency_ms: latencyMs,
        crons: cronStatus,
        stale_crons: staleJobs,
        timestamp: new Date().toISOString(),
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      },
      {
        status: allOk ? 200 : 200, // still 200 — UptimeRobot monitors for keyword "ok"
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        db: "unreachable",
        error: String(err),
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
