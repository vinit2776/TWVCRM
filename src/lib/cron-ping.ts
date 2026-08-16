import { envStr } from "@/lib/env";

/**
 * Notify the cron health tracker on job completion.
 * Call at the end of every cron route handler.
 *
 * Never throws — a failed ping must not fail the job that called it. But it is
 * no longer *silent*: a rejected ping is logged, because a monitoring call that
 * swallows its own failures reports "healthy" for a fleet that has stopped
 * running. Between 2026-04-22 and 2026-08-16 every ping here was rejected with
 * a 500 (RLS denied the write) and nothing surfaced it.
 */
export async function pingCronHealth(
  job: string,
  status: "ok" | "error" = "ok",
  details?: Record<string, unknown>
) {
  try {
    const baseUrl = envStr("NEXT_PUBLIC_APP_URL") ?? envStr("APP_URL");
    const secret = envStr("CRON_SECRET");
    if (!baseUrl || !secret) {
      console.warn(
        `[cron-ping] skipped for "${job}" — ${!baseUrl ? "NEXT_PUBLIC_APP_URL/APP_URL" : "CRON_SECRET"} not set`
      );
      return;
    }

    const res = await fetch(`${baseUrl}/api/health/cron-ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ job, status, details }),
    });

    if (!res.ok) {
      // Body may carry a Postgres/RLS message. It describes our own schema, not
      // user data, so it is safe to log and is the fastest route to a cause.
      const body = await res.text().catch(() => "<unreadable>");
      console.error(
        `[cron-ping] "${job}" ping rejected: HTTP ${res.status} ${body.slice(0, 300)}`
      );
    }
  } catch (err) {
    console.error(`[cron-ping] "${job}" ping failed to send:`, err);
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
