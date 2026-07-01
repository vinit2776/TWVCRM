import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

type Mode = "rent" | "usage" | "both";

/**
 * POST /api/billing/dispatch-run
 *
 * Starts a background billing dispatch run. Returns immediately with { run_id }
 * — the page is NOT locked. The pump cron processes jobs in the background.
 *
 * Body: { month, year, mode }
 *
 * Guards against concurrent runs for the same month/mode:
 * if a run is already queued or running for this month, returns 409.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const month: number = body.month ? parseInt(String(body.month)) : new Date().getMonth() + 1;
  const year: number  = body.year  ? parseInt(String(body.year))  : new Date().getFullYear();
  const modeIn = String(body.mode || "rent").toLowerCase();
  const mode: Mode = (modeIn === "rent" || modeIn === "usage" || modeIn === "both") ? modeIn : "rent";

  const admin = createAdminClient();

  // Guard: block concurrent runs for the same month/mode
  const { data: existing } = await admin
    .from("billing_dispatch_runs")
    .select("id, status")
    .eq("month", month)
    .eq("year", year)
    .eq("mode", mode)
    .in("status", ["queued", "running"])
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "A dispatch run is already in progress for this month. Wait for it to complete.", run_id: existing.id },
      { status: 409 },
    );
  }

  // Fetch active contracts for this mode to build the job list
  const now = new Date();
  // Rent proformas always cover NEXT month
  const prepaidMonth = mode === "usage" ? month : (month === 12 ? 1 : month + 1);
  const prepaidYear  = mode === "usage" ? year  : (month === 12 ? year + 1 : year);

  const prepaidFirst = `${prepaidYear}-${String(prepaidMonth).padStart(2, "0")}-01`;
  const daysInPrepaid = new Date(prepaidYear, prepaidMonth, 0).getDate();
  const prepaidLast  = `${prepaidYear}-${String(prepaidMonth).padStart(2, "0")}-${daysInPrepaid}`;

  // For usage mode, period is current month
  const targetFirst = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInTarget = new Date(year, month, 0).getDate();
  const targetLast  = `${year}-${String(month).padStart(2, "0")}-${daysInTarget}`;

  const periodFirst = mode === "usage" ? targetFirst : prepaidFirst;
  const periodLast  = mode === "usage" ? targetLast  : prepaidLast;

  const { data: contracts, error: contractsErr } = await admin
    .from("contracts")
    .select(`
      id, contract_number, billing_mode,
      lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
    `)
    .in("status", ["active", "renewal_in_progress"])
    .lte("start_date", periodLast)
    .gte("end_date", periodFirst);

  if (contractsErr) {
    return NextResponse.json({ error: contractsErr.message }, { status: 500 });
  }

  const contractList = contracts || [];
  if (contractList.length === 0) {
    return NextResponse.json({ error: "No active contracts found for this period." }, { status: 400 });
  }

  // Create the run row
  const { data: run, error: runErr } = await admin
    .from("billing_dispatch_runs")
    .insert({
      triggered_by: dbUser.id,
      month,
      year,
      mode,
      status: "queued",
      total_jobs: contractList.length,
      done_jobs: 0,
      failed_jobs: 0,
    })
    .select("id")
    .single();

  if (runErr || !run) {
    return NextResponse.json({ error: runErr?.message || "Failed to create run" }, { status: 500 });
  }

  // Create one job per contract
  const jobs = contractList.map((c: {
    id: string;
    contract_number: string;
    billing_mode: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lead: any;
  }) => {
    const lead = (Array.isArray(c.lead) ? c.lead[0] : c.lead) as { first_name?: string; last_name?: string; company?: string } | null;
    const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Unknown";
    return {
      run_id: run.id,
      contract_id: c.id,
      contract_number: c.contract_number,
      customer_name: customerName,
      billing_mode: c.billing_mode,
      status: "pending",
      attempt_count: 0,
      max_attempts: 3,
    };
  });

  const { error: jobsErr } = await admin.from("billing_dispatch_jobs").insert(jobs);
  if (jobsErr) {
    // Clean up the orphaned run
    await admin.from("billing_dispatch_runs").delete().eq("id", run.id);
    return NextResponse.json({ error: jobsErr.message }, { status: 500 });
  }

  // Mark as running so the pump picks it up
  await admin
    .from("billing_dispatch_runs")
    .update({ status: "running", started_at: now.toISOString() })
    .eq("id", run.id);

  return NextResponse.json({ run_id: run.id, total_jobs: contractList.length });
}

/**
 * GET /api/billing/dispatch-run
 *
 * Returns the most recent run for a given month/year/mode.
 * Used to restore the status panel if the user navigates away and returns.
 *
 * Query params: month, year, mode
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1));
  const year  = parseInt(searchParams.get("year")  || String(new Date().getFullYear()));
  const mode  = searchParams.get("mode") || "rent";

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("billing_dispatch_runs")
    .select("id, status, total_jobs, done_jobs, failed_jobs, started_at, completed_at, created_at")
    .eq("month", month)
    .eq("year", year)
    .eq("mode", mode)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) return NextResponse.json({ run: null });

  const { data: jobs } = await admin
    .from("billing_dispatch_jobs")
    .select("id, contract_number, customer_name, billing_mode, status, attempt_count, max_attempts, last_error, error_suggestion, dispatched_to, started_at, completed_at, billing_statement_id")
    .eq("run_id", run.id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ run, jobs: jobs || [] });
}
