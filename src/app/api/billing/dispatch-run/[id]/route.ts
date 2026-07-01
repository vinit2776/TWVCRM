import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/billing/dispatch-run/[id]
 *
 * Poll endpoint for the DispatchRunPanel. Returns run header + all job rows.
 * Designed to be called every 3s during an active run — one Supabase round-trip.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: run, error } = await admin
    .from("billing_dispatch_runs")
    .select("id, status, month, year, mode, total_jobs, done_jobs, failed_jobs, started_at, completed_at, created_at")
    .eq("id", id)
    .single();

  if (error || !run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: jobs } = await admin
    .from("billing_dispatch_jobs")
    .select("id, contract_number, customer_name, billing_mode, status, attempt_count, max_attempts, last_error, error_suggestion, dispatched_to, started_at, completed_at, billing_statement_id")
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ run, jobs: jobs || [] });
}
