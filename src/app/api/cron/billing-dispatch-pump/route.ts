import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { generateRentProformas, generateUsageStatements } from "@/lib/billing";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

const BATCH_SIZE = 5;
const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Maps a raw error to a human-readable fix suggestion shown in the status panel.
 * Never exposes raw stack traces or Supabase error codes to the operator.
 */
function suggestionFromError(err: unknown): string {
  const msg = String(err).toLowerCase();
  if (msg.includes("razorpay")) {
    return "Razorpay API error — check the Razorpay dashboard for this contract, then click Retry.";
  }
  if (msg.includes("resend") || msg.includes("email") || msg.includes("smtp")) {
    return "Email delivery failed — verify the client's email address in their lead record, then retry.";
  }
  if (msg.includes("b2") || msg.includes("storage") || msg.includes("upload") || msg.includes("backblaze")) {
    return "PDF upload failed (usually transient). Click Retry; if it keeps failing, check B2 credentials in Admin → Settings.";
  }
  if (msg.includes("no contact") || msg.includes("no email") || msg.includes("nocontact")) {
    return "No email address on file for this client. Update the lead record with a valid email, then click Retry.";
  }
  if (msg.includes("already sent") || msg.includes("alreadysent") || msg.includes("proforma_sent_at")) {
    return "This invoice was already sent to the client — no further action needed.";
  }
  if (msg.includes("draft") || msg.includes("not finalized")) {
    return "Statement is still in draft. Finalize it manually from the billing page, then retry.";
  }
  if (msg.includes("voided")) {
    return "Statement was voided. Create a new statement for this contract from the billing page.";
  }
  if (msg.includes("timeout")) {
    return "External service timed out. Click Retry — transient timeouts usually resolve on their own.";
  }
  return "Unexpected error. Click Retry once; if it fails again, check the contract on the billing page.";
}

/**
 * GET /api/cron/billing-dispatch-pump
 *
 * Vercel cron — fires every minute (see vercel.json).
 * Protected by CRON_SECRET header (same pattern as all other crons).
 *
 * Each tick:
 *   1. Recover stale 'processing' jobs (pump crashed or timed out > 6 min ago)
 *   2. Find the oldest running billing_dispatch_run
 *   3. Claim BATCH_SIZE pending jobs via claim_dispatch_batch() RPC (FOR UPDATE SKIP LOCKED)
 *   4. For each job: generate statement if needed → finalize → dispatch
 *   5. Update job status (sent / failed)
 *   6. Update run counters; mark completed/partial/failed when all jobs are terminal
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // ── 1. Recover stale jobs ────────────────────────────────────────────────
  await admin.rpc("recover_stale_dispatch_jobs", { p_stale_minutes: 6 });

  // ── 2. Find the oldest running run ────────────────────────────────────────
  const { data: run } = await admin
    .from("billing_dispatch_runs")
    .select("id, month, year, mode, total_jobs, done_jobs, failed_jobs")
    .eq("status", "running")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!run) {
    return NextResponse.json({ ok: true, message: "No active runs" });
  }

  // ── 3. Claim next batch ────────────────────────────────────────────────────
  const { data: claimedIds } = await admin.rpc("claim_dispatch_batch", {
    p_run_id: run.id,
    p_batch: BATCH_SIZE,
  });

  const ids = (claimedIds as string[] | null) || [];
  if (ids.length === 0) {
    // All jobs are either processing (by another tick) or terminal — check if done
    await maybeCompleteRun(admin, run.id);
    return NextResponse.json({ ok: true, message: "No pending jobs in this batch" });
  }

  // ── 4. Fetch claimed job details ──────────────────────────────────────────
  const { data: jobs } = await admin
    .from("billing_dispatch_jobs")
    .select("id, contract_id, contract_number, billing_mode, billing_statement_id, attempt_count, max_attempts")
    .in("id", ids);

  const results = { sent: 0, failed: 0, skipped: 0 };

  for (const job of jobs || []) {
    const jid = job.id as string;
    const contractId = job.contract_id as string;
    const billingMode = (job.billing_mode as string | null) ?? "proforma_first";
    const existingStatementId = job.billing_statement_id as string | null;
    const attemptCount = (job.attempt_count as number) + 1;

    try {
      let statementId = existingStatementId;

      // ── 4a. Generate statement if not yet created ────────────────────────
      // Idempotency: if billing_statement_id is already set, skip generation
      // and go straight to dispatch (handles retries after partial failures).
      if (!statementId) {
        const isUsage = (run.mode as string) === "usage";
        const genOpts = {
          month: run.month as number,
          year: run.year as number,
          contractId,
          dryRun: false,
        };

        const genResult = isUsage
          ? await generateUsageStatements(admin, genOpts)
          : await generateRentProformas(admin, genOpts);

        // generateRentProformas / generateUsageStatements also dispatches
        // internally — it's the existing monolithic flow. We check if the
        // statement was generated+sent successfully by looking at statementIds.
        if (genResult.alreadySent?.includes(job.contract_number as string)) {
          // Statement was already sent in a previous cycle — mark as skipped
          await admin.from("billing_dispatch_jobs").update({
            status: "skipped",
            completed_at: new Date().toISOString(),
            error_suggestion: "Already sent in a previous billing run.",
          }).eq("id", jid);
          results.skipped++;
          continue;
        }

        if (genResult.errors?.length > 0) {
          throw new Error(genResult.errors[0]);
        }

        if (genResult.noContact?.includes(job.contract_number as string)) {
          throw new Error("No contact info — no email or phone on file");
        }

        // The generator dispatches internally — if we reach here, it succeeded.
        // Record the statement id for idempotency on retry.
        statementId = genResult.statementIds?.[0] ?? null;

        if (statementId) {
          await admin.from("billing_dispatch_jobs").update({
            billing_statement_id: statementId,
            attempt_count: attemptCount,
          }).eq("id", jid);
        }

        // Mark as sent — the generator already dispatched
        const dispatchedTo = genResult.statementIds?.length > 0 ? "dispatched" : null;
        await admin.from("billing_dispatch_jobs").update({
          status: "sent",
          attempt_count: attemptCount,
          dispatched_to: dispatchedTo,
          completed_at: new Date().toISOString(),
          last_error: null,
          error_suggestion: null,
        }).eq("id", jid);
        results.sent++;
        continue;
      }

      // ── 4b. Retry path: statement exists, only redo dispatch ─────────────
      // Statement was already generated in a prior attempt but dispatch failed.
      // Skip generation entirely — just dispatch again.
      const isGstDirect = billingMode === "gst_direct";

      const handoff = await handleStatementFinalized(
        admin,
        statementId,
        billingMode as "proforma_first" | "gst_direct" | null,
        "billing_dispatch_pump_retry",
      );

      let dispatchResult;
      if (handoff.skipLegacyDispatch) {
        // GST direct + v2 handoff: already queued to Tally inbox, no email needed
        dispatchResult = { success: true, noContact: false, emailedTo: null, razorpayLinkUrl: null };
      } else if (isGstDirect) {
        dispatchResult = await dispatchGstDirect(admin, statementId, null, []);
      } else {
        dispatchResult = await dispatchProforma(admin, statementId, null, []);
      }

      if (dispatchResult.noContact) {
        throw new Error("No contact info — no email or phone on file");
      }

      await admin.from("billing_dispatch_jobs").update({
        status: "sent",
        attempt_count: attemptCount,
        dispatched_to: dispatchResult.emailedTo || null,
        completed_at: new Date().toISOString(),
        last_error: null,
        error_suggestion: null,
      }).eq("id", jid);
      results.sent++;

    } catch (err) {
      const errMsg = String(err);
      const suggestion = suggestionFromError(err);
      const isExhausted = attemptCount >= (job.max_attempts as number);

      await admin.from("billing_dispatch_jobs").update({
        status: isExhausted ? "failed" : "pending",
        attempt_count: attemptCount,
        last_error: errMsg.slice(0, 500),
        error_suggestion: isExhausted ? suggestion : null,
        completed_at: isExhausted ? new Date().toISOString() : null,
        started_at: null,
      }).eq("id", jid);

      if (isExhausted) results.failed++;
    }

    // Small inter-job breather — stays under Razorpay + Resend rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── 5. Update run counters and check completion ───────────────────────────
  const { error: incrErr } = await admin.rpc("increment_dispatch_run_counters", {
    p_run_id: run.id,
    p_sent: results.sent + results.skipped,
    p_failed: results.failed,
  });
  if (incrErr) {
    // Fallback: manual counter update if RPC is not yet deployed
    await admin
      .from("billing_dispatch_runs")
      .update({
        done_jobs: (run.done_jobs as number) + results.sent + results.skipped,
        failed_jobs: (run.failed_jobs as number) + results.failed,
      })
      .eq("id", run.id);
  }

  await maybeCompleteRun(admin, run.id);

  return NextResponse.json({ ok: true, run_id: run.id, ...results });
}

/**
 * Checks if all jobs in a run are terminal (sent/failed/skipped).
 * If so, marks the run completed/partial/failed.
 */
async function maybeCompleteRun(
  admin: ReturnType<typeof createAdminClient>,
  runId: string,
) {
  const { data: counts } = await admin
    .from("billing_dispatch_jobs")
    .select("status")
    .eq("run_id", runId);

  if (!counts || counts.length === 0) return;

  const total = counts.length;
  const pending = counts.filter((j: { status: string }) => j.status === "pending" || j.status === "processing").length;
  const failed  = counts.filter((j: { status: string }) => j.status === "failed").length;
  const sent    = counts.filter((j: { status: string }) => j.status === "sent" || j.status === "skipped").length;

  if (pending > 0) return; // Still in progress

  let finalStatus: string;
  if (failed === 0) {
    finalStatus = "completed";
  } else if (sent === 0) {
    finalStatus = "failed";
  } else {
    finalStatus = "partial";
  }

  await admin
    .from("billing_dispatch_runs")
    .update({
      status: finalStatus,
      done_jobs: sent,
      failed_jobs: failed,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

export const maxDuration = 55; // stay under Vercel 60s function limit
