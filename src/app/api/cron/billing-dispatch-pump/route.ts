import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { processDispatchRun, triggerDispatchContinuation } from "@/lib/billing-dispatch";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/billing-dispatch-pump
 *
 * Scheduled every 30 minutes (see vercel.json) — but that interval mostly
 * doesn't matter anymore. A run's actual completion speed comes from
 * self-chaining: this route (and the immediate triggers fired by "Run &
 * Send" and "Retry" — see src/lib/billing-dispatch.ts) call
 * processDispatchRun(), which loops batches internally for ~45s, then if
 * work remains, schedules an immediate follow-up call to itself via
 * triggerDispatchContinuation() instead of waiting for the next tick.
 *
 * The scheduled interval is now just a safety net: it catches (a) a run
 * whose self-chain was somehow interrupted, and (b) jobs stuck in
 * 'processing' from a crashed invocation (recovered after 6 min, checked
 * at the top of every processDispatchRun call).
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  const authHeader = req.headers.get("authorization");
  const isAuthorized = secret === CRON_SECRET || authHeader === `Bearer ${CRON_SECRET}`;
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const chainDepth = parseInt(req.nextUrl.searchParams.get("chain") || "0", 10) || 0;

  const admin = createAdminClient();

  const { data: run } = await admin
    .from("billing_dispatch_runs")
    .select("id")
    .eq("status", "running")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!run) {
    return NextResponse.json({ ok: true, message: "No active runs" });
  }

  const result = await processDispatchRun(run.id);

  if (result.hasMoreWork) {
    after(() => triggerDispatchContinuation(chainDepth));
  }

  return NextResponse.json({ ok: true, run_id: run.id, ...result });
}

export const maxDuration = 55; // stay under Vercel 60s function limit
