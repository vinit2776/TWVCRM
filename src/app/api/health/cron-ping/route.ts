import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// Called by each cron job on successful completion:
//   POST /api/health/cron-ping  { job: "digest", status: "ok", details: {...} }
// Secured with CRON_SECRET header so only Vercel crons can call it.
//
// Writes with the service-role client. cron_health has RLS enabled with a
// SELECT-only policy (migration 00110) and no INSERT/UPDATE policy — writes are
// expected to come from the service role. This route previously used
// createClient(), which carries the caller's cookie session; a cron request has
// no cookies, so the upsert ran as `anon` and was silently denied for four
// months. The CRON_SECRET check above is what authorises this call.

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { job, status = "ok", details } = body as {
    job: string;
    status?: string;
    details?: Record<string, unknown>;
  };

  if (!job) return NextResponse.json({ error: "job required" }, { status: 400 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("cron_health").upsert(
    { job, last_run_at: new Date().toISOString(), last_status: status, details: details ?? null },
    { onConflict: "job" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, job, status });
}
