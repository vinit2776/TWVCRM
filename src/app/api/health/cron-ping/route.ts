import { NextRequest, NextResponse } from "next/server";
import { recordCronHealth } from "@/lib/cron-ping";

// Manual / external cron health ping:
//   POST /api/health/cron-ping  { job: "digest", status: "ok", details: {...} }
// Secured with CRON_SECRET so only trusted callers can write.
//
// The app's own cron jobs no longer come through here — pingCronHealth() writes
// to Postgres directly, which saves a serverless invocation and a network round
// trip on every one of the ~960 cron runs a day. This route stays as the manual
// escape hatch (backfilling a row, testing the pipeline from outside, letting a
// job that runs off-platform report in) and shares the same write path, so the
// two can't drift.

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { job, status = "ok", details } = body as {
    job: string;
    status?: "ok" | "error";
    details?: Record<string, unknown>;
  };

  if (!job) return NextResponse.json({ error: "job required" }, { status: 400 });

  try {
    await recordCronHealth(job, status, details);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true, job, status });
}
