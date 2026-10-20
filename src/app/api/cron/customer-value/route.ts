import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { refreshScores } from "@/lib/customer-value/scores-refresh";

// Nightly. Recomputes every customer's monthly figures and today's Value score
// from CRM records. Read-only against everything but its own two snapshot tables
// (customer_value_monthly, customer_value_scores); it sends nothing to anyone.
export const maxDuration = 60;

/** Past this the run is close to the platform limit: report it as an error so it is seen, not silently killed later. */
const SLOW_MS = 45_000;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const r = await refreshScores(createAdminClient(), todayYmdIst(), { write: true, scores: "latest", writeLeadIds: null });
    const durationMs = Date.now() - started;
    const slow = durationMs > SLOW_MS;
    // Non-2xx so cron_health records "error": a bad settings override or a run
    // nearing its time limit must not look like a healthy night.
    const problem = slow || r.warnings.length > 0;
    return NextResponse.json(
      {
        customers: r.customers,
        monthly_rows: r.monthlyRows,
        score_rows: r.scoreRows,
        graded: r.graded,
        not_enough_data: r.notEnoughData,
        tiers: r.tiers,
        settings_version: r.settingsVersion,
        warnings: r.warnings,
        duration_ms: durationMs,
        slow,
      },
      { status: problem ? 502 : 200 }
    );
  } catch (err) {
    console.error("[customer-value] nightly run failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Customer value run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/customer-value", handler);
