/**
 * GET  /api/tally/jobs        — paginated audit log of sync jobs (admin only)
 * POST /api/tally/jobs        — retry a failed job (admin only)
 *
 * The audit log: every job that passed through the bridge, its status,
 * the Tally invoice number + IRN it produced, timestamps, and any error.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, dbUser: null };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const, dbUser: null };
  }
  return { error: null, status: 200 as const, dbUser };
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const page   = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit  = Math.min(100, parseInt(searchParams.get("limit") || "25"));
  const status = searchParams.get("status"); // pending|claimed|posted|completed|failed
  const offset = (page - 1) * limit;

  const admin = createAdminClient();
  let query = admin
    .from("tally_sync_jobs")
    .select(
      "id, job_type, status, idempotency_key, tally_invoice_number, tally_irn, " +
      "tally_voucher_guid, attempt_count, max_attempts, last_error, " +
      "voucher_created_at, created_at, completed_at, last_attempted_at, billing_statement_id",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data: data ?? [],
    pagination: {
      page, limit,
      total: count ?? 0,
      totalPages: Math.max(1, Math.ceil((count ?? 0) / limit)),
    },
  });
}

const RetrySchema = z.object({
  action: z.literal("retry"),
  job_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = RetrySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const admin = createAdminClient();

  // Only failed jobs can be retried. Reset to pending, clear lease + error,
  // reset attempt_count so it gets a fresh set of retries.
  const { data: job } = await admin
    .from("tally_sync_jobs").select("id, status, job_type, last_error, billing_statement_id")
    .eq("id", parsed.data.job_id).single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "failed") {
    return NextResponse.json({ error: `Only failed jobs can be retried (this one is '${job.status}')` }, { status: 400 });
  }

  // For sales_voucher jobs that failed with "missing ledger", enqueue a party_master first.
  // The party_master (earlier created_at) is processed before the re-queued sales_voucher;
  // on party_master ack success the ack handler re-queues any still-failed sales_voucher.
  const lastError: string = (job.last_error as string | null) ?? "";
  if (job.job_type === "sales_voucher" && job.billing_statement_id && lastError.includes("does not exist in Tally")) {
    try {
      const { data: stmtLead } = await admin
        .from("billing_statements")
        .select(`contract:contracts!billing_statements_contract_id_fkey(
          lead_id,
          lead:leads!contracts_lead_id_fkey(
            company, first_name, last_name, gst_number, state, street, city, zip_code
          )
        )`)
        .eq("id", job.billing_statement_id)
        .single();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const leadId   = (stmtLead as any)?.contract?.lead_id as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const leadData = (stmtLead as any)?.contract?.lead;

      if (leadId && leadData) {
        const pmName = (leadData.company as string | undefined)?.trim()
          || `${leadData.first_name ?? ""} ${leadData.last_name ?? ""}`.trim()
          || "Customer";

        // 23505 = already queued/completed for this lead = fine (idempotent)
        await admin.from("tally_sync_jobs").insert({
          job_type:             "party_master",
          billing_statement_id: job.billing_statement_id,
          idempotency_key:      `party_master:${job.billing_statement_id}`,
          status:               "pending",
          payload: {
            lead_id:    leadId,
            party_name: pmName,
            gst_number: (leadData.gst_number as string | null) ?? null,
            state:      (leadData.state     as string | null) ?? null,
            street:     (leadData.street    as string | null) ?? null,
            city:       (leadData.city      as string | null) ?? null,
            zip_code:   (leadData.zip_code  as string | null) ?? null,
          },
        });
      }
    } catch {
      // best-effort — proceed with retry even if party_master enqueue fails
    }
  }

  await admin.from("tally_sync_jobs").update({
    status: "pending",
    attempt_count: 0,
    last_error: null,
    claimed_at: null,
    lease_expires_at: null,
    claimed_by: null,
  }).eq("id", parsed.data.job_id);

  if (job.billing_statement_id) {
    await admin.from("billing_statements")
      .update({ tally_sync_status: "pending", tally_last_error: null })
      .eq("id", job.billing_statement_id);
  }

  void logAudit(admin, {
    entityType: "billing_statement" as never,
    entityId:   job.billing_statement_id ?? parsed.data.job_id,
    action:     "update" as never,
    performedBy: auth.dbUser!.id,
    changes:    { tally_retry: { old: "failed", new: "pending" } },
  });

  return NextResponse.json({ ok: true });
}
