import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { refreshShadowMargins } from "@/lib/customer-value/margin-refresh";

// Nightly, after the Value snapshot (customer-value). Works out margin after
// variable costs for every customer-month from the stored monthly figures and the
// cost rates in force, and stores it beside the score. The score itself is not
// changed by it. Read-only against everything but customer_value_margin; sends
// nothing to anyone.
export const maxDuration = 60;

const SLOW_MS = 45_000;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const r = await refreshShadowMargins(createAdminClient(), todayYmdIst(), { write: true });
    const durationMs = Date.now() - started;
    const slow = durationMs > SLOW_MS;
    // Non-2xx so cron_health records "error": an unreadable center or a run near the time limit must be seen.
    return NextResponse.json(
      { customers: r.customers, rows: r.rows, with_electricity: r.withElectricity, warnings: r.warnings, duration_ms: durationMs, slow },
      { status: slow || r.warnings.length > 0 ? 502 : 200 }
    );
  } catch (err) {
    console.error("[customer-value-margin] nightly run failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Customer value margin run failed" }, { status: 500 });
  }
}

export const GET = withCronHealth("cron/customer-value-margin", handler);
