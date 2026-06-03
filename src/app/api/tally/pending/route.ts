/**
 * GET /api/tally/pending
 *
 * Bridge-only endpoint. Returns a batch of pending Tally sync jobs and
 * claims them with a lease. The bridge must ack (POST /api/tally/ack)
 * before the lease expires or the job re-surfaces for retry.
 *
 * Also re-surfaces any claimed jobs whose lease has expired (bridge crash).
 *
 * Auth: Bearer TALLY_AGENT_TOKEN (not a user session)
 *
 * Response:
 *   { jobs: TallySyncJob[] }
 *
 * Lease semantics:
 *   - claimed_at      = now
 *   - lease_expires_at = now + LEASE_SECONDS
 *   - status          = 'claimed'
 *   If bridge acks before expiry → status = 'completed' | 'failed'
 *   If bridge crashes            → job re-surfaces on next poll after expiry
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

const BATCH_SIZE    = 5;    // jobs per poll — keeps individual Tally posts manageable
const LEASE_SECONDS = 120;  // bridge must ack within 2 minutes or job re-surfaces

function authGuard(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${process.env.TALLY_AGENT_TOKEN}`;
}

export async function GET(request: NextRequest) {
  if (!authGuard(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_SECONDS * 1000);

  // Re-surface any jobs whose lease has expired (crashed bridge)
  await supabase
    .from("tally_sync_jobs")
    .update({ status: "pending", claimed_at: null, lease_expires_at: null, claimed_by: null })
    .eq("status", "claimed")
    .lt("lease_expires_at", now.toISOString());

  // Check master switch
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["tally_sync_enabled", "tally_company_gstin"]);

  const settingsMap = Object.fromEntries(
    (settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value])
  );

  if (settingsMap["tally_sync_enabled"] !== "true") {
    return NextResponse.json({ jobs: [], reason: "tally_sync_disabled" });
  }

  // Claim a batch atomically: select then update
  // Note: Postgres has no SELECT FOR UPDATE SKIP LOCKED via PostgREST,
  // so we use a deterministic ordering + lease expiry as the dedup.
  // Single-flight is enforced by the bridge itself (one concurrent poster).
  const { data: jobs, error } = await supabase
    .from("tally_sync_jobs")
    .select(`
      id, job_type, idempotency_key, payload,
      billing_statement_id, gst_invoice_id,
      attempt_count, max_attempts
    `)
    .eq("status", "pending")
    .lt("attempt_count", BATCH_SIZE)     // don't pick up exhausted jobs
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[tally/pending] query error:", error.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  const jobIds = jobs.map((j: { id: string }) => j.id);
  const bridgeInstanceId = request.headers.get("x-bridge-instance-id") ?? "unknown";

  // Claim the batch + increment attempt counts individually
  // (Supabase PostgREST doesn't support col+1 in update, so two passes)
  for (const job of jobs) {
    await supabase
      .from("tally_sync_jobs")
      .update({
        status:            "claimed",
        claimed_at:        now.toISOString(),
        lease_expires_at:  leaseExpiry.toISOString(),
        claimed_by:        bridgeInstanceId,
        attempt_count:     (job.attempt_count ?? 0) + 1,
        last_attempted_at: now.toISOString(),
      })
      .eq("id", job.id);
  }

  return NextResponse.json({
    jobs,
    tally_company_gstin: settingsMap["tally_company_gstin"] ?? "",
    lease_seconds: LEASE_SECONDS,
  });
}
