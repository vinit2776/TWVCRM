import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

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

    // Messaging channel health — precomputed by /api/cron/messaging-health, so
    // this stays a single indexed row read on an endpoint polled every minute.
    //
    // Read with the admin client: this endpoint is public and usually called
    // without a session, and messaging_health_state (like cron_health) is only
    // readable by authenticated users under RLS.
    //
    // Only status and counts are exposed. dominant_error is deliberately
    // withheld — it is raw provider text that carries the sender number.
    const messaging: Record<string, { status: string; fail_rate: number; sample_size: number; stale: boolean }> = {};
    const messagingProblems: string[] = [];

    try {
      const { data: msgRows } = await createAdminClient()
        .from("messaging_health_state")
        .select("channel, status, fail_rate, sample_size, template_issues, last_checked_at");

      for (const row of msgRows ?? []) {
        // The cron runs every 30 min; >2h without a write means it stopped.
        const stale = Date.now() - new Date(row.last_checked_at).getTime() > 2 * 3_600_000;
        messaging[row.channel] = {
          status: stale ? "unknown" : row.status,
          fail_rate: Number(row.fail_rate),
          sample_size: row.sample_size,
          stale,
        };
        if (stale) messagingProblems.push(`${row.channel}:stale`);
        else if (row.status === "down" || row.status === "degraded") {
          messagingProblems.push(`${row.channel}:${row.status}`);
        }
        const issues = (row.template_issues ?? []) as unknown[];
        if (issues.length > 0) messagingProblems.push(`${row.channel}:${issues.length} template issue(s)`);
      }
    } catch (err) {
      // Never let the messaging read take down the health endpoint itself —
      // DB reachability is the primary signal and it already passed above.
      console.error("[health] messaging state read failed:", err);
    }

    const latencyMs = Date.now() - start;
    const allOk = staleJobs.length === 0 && messagingProblems.length === 0;

    return NextResponse.json(
      {
        status: allOk ? "ok" : "degraded",
        db: "connected",
        latency_ms: latencyMs,
        crons: cronStatus,
        stale_crons: staleJobs,
        messaging,
        messaging_problems: messagingProblems,
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
