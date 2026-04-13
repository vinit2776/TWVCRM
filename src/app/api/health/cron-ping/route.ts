import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Called by each cron job on successful completion:
//   POST /api/health/cron-ping  { job: "digest", status: "ok", details: {...} }
// Secured with CRON_SECRET header so only Vercel crons can call it.

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

  const supabase = await createClient();
  const { error } = await supabase.from("cron_health").upsert(
    { job, last_run_at: new Date().toISOString(), last_status: status, details: details ?? null },
    { onConflict: "job" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, job, status });
}
