import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { processDispatchRun, triggerDispatchContinuation } from "@/lib/billing-dispatch";

/**
 * POST /api/billing/dispatch-run/[id]/retry-job/[jobId]
 *
 * Re-queues a FAILED job so the pump picks it up on the next tick.
 * Resets attempt_count to 0 so it gets a fresh 3-attempt budget.
 * Only allowed on jobs with status='failed'.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: runId, jobId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();

  // Verify job belongs to this run and is failed
  const { data: job } = await admin
    .from("billing_dispatch_jobs")
    .select("id, status, run_id")
    .eq("id", jobId)
    .eq("run_id", runId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "failed") {
    return NextResponse.json({ error: "Only failed jobs can be retried" }, { status: 400 });
  }

  // Reset to pending with a fresh attempt budget
  const { error } = await admin
    .from("billing_dispatch_jobs")
    .update({
      status: "pending",
      attempt_count: 0,
      last_error: null,
      error_suggestion: null,
      started_at: null,
      completed_at: null,
    })
    .eq("id", jobId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Ensure the parent run is marked running so the pump keeps processing
  await admin
    .from("billing_dispatch_runs")
    .update({ status: "running", completed_at: null })
    .eq("id", runId)
    .in("status", ["completed", "partial", "failed"]);

  // Process this retry immediately instead of waiting for the next
  // scheduled pump tick.
  after(async () => {
    const result = await processDispatchRun(runId);
    if (result.hasMoreWork) {
      await triggerDispatchContinuation();
    }
  });

  return NextResponse.json({ ok: true });
}
