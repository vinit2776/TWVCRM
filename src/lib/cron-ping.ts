import { createAdminClient } from "@/lib/supabase/server";

/**
 * Write a cron job's last-run time and status.
 *
 * Throws on failure — callers decide what to do about it. pingCronHealth()
 * swallows and logs; the /api/health/cron-ping route turns it into a 500.
 *
 * cron_health has RLS enabled with a SELECT-only policy (migration 00110) and
 * no write policy, so this must use the service-role client.
 */
export async function recordCronHealth(
  job: string,
  status: "ok" | "error" = "ok",
  details?: Record<string, unknown>
) {
  const { error } = await createAdminClient().from("cron_health").upsert(
    {
      job,
      last_run_at: new Date().toISOString(),
      last_status: status,
      details: details ?? null,
    },
    { onConflict: "job" }
  );

  if (error) throw new Error(error.message);
}

/**
 * Notify the cron health tracker on job completion.
 * Call at the end of every cron route handler.
 *
 * Writes straight to Postgres. This used to POST to our own
 * /api/health/cron-ping over the public URL, which meant every one of the ~960
 * cron runs per day spent a second serverless invocation and a network round
 * trip to reach a table in the database the caller was already talking to.
 * Worse, it made the monitor depend on NEXT_PUBLIC_APP_URL being correct and on
 * an HTTP response nobody inspected — which is precisely how a four-month
 * backup outage stayed invisible. Fewer moving parts between the job and the
 * row is the whole point.
 *
 * Never throws — a failed ping must not fail the job that called it — but it is
 * not silent either. A monitoring call that swallows its own failures reports
 * "healthy" for a fleet that has stopped running.
 */
export async function pingCronHealth(
  job: string,
  status: "ok" | "error" = "ok",
  details?: Record<string, unknown>
) {
  try {
    await recordCronHealth(job, status, details);
  } catch (err) {
    // The message describes our own schema, not user data, so it is safe to log
    // and is the fastest route to a cause.
    console.error(`[cron-ping] "${job}" health write failed:`, err);
  }
}

type CronHandler<Req> = (request: Req) => Promise<Response>;

/**
 * Wraps a cron route handler so it reports health on every exit path.
 *
 * Preferred over calling pingCronHealth() by hand at each `return`: handlers
 * grow new early-returns over time and the hand-placed calls drift out of
 * date, and a handler that *throws* never reported at all. Here a thrown error
 * and a non-2xx response both record "error".
 *
 *   async function handler(request: NextRequest) { ... }
 *   export const GET = withCronHealth("cron/my-job", handler);
 *
 * `job` must match a key in CRON_THRESHOLDS in src/app/api/health/route.ts,
 * which is the route path with "/api/" stripped.
 */
export function withCronHealth<Req>(
  job: string,
  handler: CronHandler<Req>
): CronHandler<Req> {
  return async (request: Req) => {
    try {
      const res = await handler(request);
      // 401 means an unauthenticated probe hit the endpoint, not that the job
      // ran. Recording it would reset the staleness clock without any work
      // being done — exactly the false "healthy" this endpoint exists to catch.
      if (res.status !== 401) {
        await pingCronHealth(job, res.ok ? "ok" : "error", { http_status: res.status });
      }
      return res;
    } catch (err) {
      await pingCronHealth(job, "error", { error: String(err).slice(0, 300) });
      throw err;
    }
  };
}
