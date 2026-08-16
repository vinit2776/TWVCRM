import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// Max allowed hours since last run before a cron is flagged as stale.
//
// Job names mirror the route path with "/api/" stripped, so every entry here
// maps to exactly one `crons` entry in vercel.json. Thresholds are the job's
// own period plus grace — a weekly job checked against a 26h default would
// alert six days out of seven, which is how a monitor gets muted and stops
// being a monitor.
//
// Keep in sync with vercel.json. `expected_crons_missing` in the response
// flags any scheduled job that has never reported.
const HOUR = 1;
const DAILY = 26;        // 24h + 2h grace
const WEEKLY = 24 * 7 + 2;
const MONTHLY = 24 * 32; // covers the 28→28 gap in short months

const CRON_THRESHOLDS: Record<string, number> = {
  // sub-hourly
  "cron/cosec-events":            2,
  "cron/lead-reminder-whatsapp":  2,
  "cron/tally-reconcile":         2,
  "cron/unifi-ap-health":         2,
  "cron/billing-dispatch-pump":   3,
  "cron/cosec-booking-cleanup":   3,
  "cron/messaging-health":        3,
  "cron/comp-request-expiry":     3 * HOUR,
  // every 6h
  "cron/facility-sla-check":      8,
  "cron/query-escalation":        8,
  // daily
  "petty-cash/day-book":          DAILY,
  "digest":                       DAILY,
  "cron/team-activity-digest":    DAILY,
  "cron/payment-reminder":        DAILY,
  "cron/settlement-recon":        DAILY,
  "cron/pending-payment-report":  DAILY,
  "cron/db-backup":               DAILY,
  "cron/storage-backup":          DAILY,
  "cron/contract-expiry":         DAILY,
  "cron/lead-reminder-digest":    DAILY,
  "cron/vo-renewal":              DAILY,
  "cron/renewal-reminders":       DAILY,
  "cron/lease-payment-reminders": DAILY,
  "cron/inbox-digest":            DAILY,
  // Mon–Sat, 3×/day — the Sat 12:30 → Mon 04:30 gap is ~40h
  "cron/headcount-reminder":      44,
  // weekly
  "cron/kyc-reminder":            WEEKLY,
  "cron/vendor-email-digest":     WEEKLY,
  "cron/invoice-gap-audit":       WEEKLY,
  // monthly
  "cron/billing-reminder":        MONTHLY,
  "cron/aggregator-invoicing":    MONTHLY,
  "cron/lease-payment-generator": MONTHLY,
  "cron/lease-escalation-check":  MONTHLY,
  "cron/electricity-nag":         MONTHLY,
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

    // Check cron staleness.
    //
    // Read with the admin client: this endpoint is public and normally called
    // without a session (UptimeRobot), and cron_health is admin/manager-only
    // under RLS. Reading it as `anon` returned an empty set, so staleJobs was
    // always empty and this endpoint reported "ok" for a fleet that had not
    // written a health row since April. Only job names and timestamps are
    // exposed below — `details` may carry connection strings and is not read.
    const { data: cronRows } = await createAdminClient()
      .from("cron_health")
      .select("job, last_run_at, last_status");

    const staleJobs: string[] = [];
    const failingJobs: string[] = [];
    const cronStatus: Record<string, { last_run_at: string; hours_ago: number; status: string }> = {};

    for (const row of (cronRows ?? [])) {
      const hoursAgo = (Date.now() - new Date(row.last_run_at).getTime()) / 3_600_000;
      const threshold = CRON_THRESHOLDS[row.job] ?? DAILY;
      cronStatus[row.job] = {
        last_run_at: row.last_run_at,
        hours_ago: Math.round(hoursAgo * 10) / 10,
        status: row.last_status,
      };
      if (hoursAgo > threshold) staleJobs.push(row.job);
      // A job that runs on time but reports "error" every time is just as dead
      // as one that stopped — cron/db-backup sat at "error" for four months.
      else if (row.last_status === "error") failingJobs.push(row.job);
    }

    // Scheduled jobs that have never written a row at all. Informational only:
    // a monthly job legitimately shows up here until its first run after a
    // deploy, so this must not flip the endpoint to degraded on its own.
    const reported = new Set((cronRows ?? []).map((r) => r.job));
    const neverReported = Object.keys(CRON_THRESHOLDS).filter((j) => !reported.has(j));

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
    const allOk =
      staleJobs.length === 0 &&
      failingJobs.length === 0 &&
      messagingProblems.length === 0;

    return NextResponse.json(
      {
        status: allOk ? "ok" : "degraded",
        db: "connected",
        latency_ms: latencyMs,
        crons: cronStatus,
        stale_crons: staleJobs,
        failing_crons: failingJobs,
        expected_crons_missing: neverReported,
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
