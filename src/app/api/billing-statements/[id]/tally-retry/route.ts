import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/tally-retry
 *
 * Re-queue the statement's failed Tally job (sales_voucher / receipt_voucher /
 * credit_note) so the bridge re-attempts it. Clears the error and resets the
 * lifecycle so the UI stops showing a dead-end.
 *
 * admin / accounts / manager. Only acts on a job in a retryable state (failed,
 * or a stale claimed/posted one) — never disturbs a completed job.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Not allowed to retry Tally sync" }, { status: 403 });
  }

  const admin = createAdminClient();

  // Most-recent job for this statement that is in a non-terminal/failed state.
  const { data: job } = await admin
    .from("tally_sync_jobs")
    .select("id, status, job_type, attempt_count, idempotency_key")
    .eq("billing_statement_id", id)
    .in("status", ["failed", "claimed", "posted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) {
    return NextResponse.json(
      { error: "No retryable Tally job found for this statement (nothing failed, or it already completed)." },
      { status: 409 },
    );
  }

  // Reset the job to pending so the next poll re-attempts it. Reset attempt_count
  // so it isn't immediately filtered out as exhausted.
  await admin.from("tally_sync_jobs").update({
    status:           "pending",
    last_error:       null,
    claimed_at:       null,
    lease_expires_at: null,
    claimed_by:       null,
    attempt_count:    0,
  }).eq("id", job.id);

  // Reset the statement's Tally lifecycle so the UI shows "queued" again, not failed.
  // 'credit_note' returns to 'cancelling'; sales/receipt to 'queued'.
  const stage = job.job_type === "credit_note" ? "cancelling" : "queued";
  await admin.from("billing_statements").update({
    tally_sync_status: "pending",
    lifecycle_stage:   stage,
    tally_last_error:  null,
  }).eq("id", id);

  void logAudit(admin, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { tally_retry: { old: "failed", new: stage }, job_type: { old: null, new: job.job_type } },
  });

  return NextResponse.json({
    ok: true,
    job_type: job.job_type,
    message: "Tally sync re-queued. The bridge will retry on its next poll.",
  });
}
