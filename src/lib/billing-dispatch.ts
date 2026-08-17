import { createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { generateRentProformas, generateUsageStatements } from "@/lib/billing";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

// Claim one job at a time. Each job can involve several sequential SMTP
// sends plus PDF/B2/Razorpay/Tally calls (observed 5-15s), so claiming a
// batch of several jobs risked the loop still being mid-batch when Vercel's
// 55s hard limit killed the invocation — orphaning the rest of that batch in
// 'processing' with no way to finish or hand off, since a hard kill also
// prevents the after() continuation from firing. Claiming 1 at a time keeps
// the "how much more work is safely startable" check aligned with what's
// actually in flight.
const BATCH_SIZE = 1;
// Leaves headroom under Vercel's 55s function limit (see maxDuration in the
// cron route) for the in-flight job to finish cleanly before the loop's own
// check would otherwise start another one.
const TIME_BUDGET_MS = 30_000;
const MAX_CHAIN_DEPTH = 30; // ~15 min of continuous processing at worst; the
// scheduled cron tick is the fallback safety net if this is ever exceeded.

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

export interface DispatchProcessResult {
  sent: number;
  failed: number;
  skipped: number;
  /** True if the time budget was hit while pending jobs still remain. */
  hasMoreWork: boolean;
}

/**
 * Processes as many pending jobs for a run as fit within a bounded time
 * budget, looping batch-by-batch instead of doing just one batch per call.
 *
 * Shared by four call sites: the scheduled pump cron, the immediate trigger
 * fired after "Run & Send", the immediate trigger fired after a manual
 * "Retry", and self-chained follow-up calls (see triggerDispatchContinuation
 * below) — so a run's completion speed no longer depends on how often the
 * cron itself is scheduled to run.
 */
export async function processDispatchRun(runId: string): Promise<DispatchProcessResult> {
  const admin = createAdminClient();
  const startedAt = Date.now();
  const totals = { sent: 0, failed: 0, skipped: 0 };

  await admin.rpc("recover_stale_dispatch_jobs", { p_stale_minutes: 6 });

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { data: run } = await admin
      .from("billing_dispatch_runs")
      .select("id, month, year, mode")
      .eq("id", runId)
      .eq("status", "running")
      .maybeSingle();

    if (!run) break; // completed, voided, or no longer running

    const { data: claimedIds } = await admin.rpc("claim_dispatch_batch", {
      p_run_id: run.id,
      p_batch: BATCH_SIZE,
    });
    const ids = (claimedIds as string[] | null) || [];

    if (ids.length === 0) {
      await maybeCompleteRun(admin, run.id);
      break; // nothing currently claimable — either done, or another
      // invocation is mid-batch on the remaining jobs right now
    }

    const { data: jobs } = await admin
      .from("billing_dispatch_jobs")
      .select("id, contract_id, contract_number, billing_mode, billing_statement_id, attempt_count, max_attempts")
      .in("id", ids);

    const batch = { sent: 0, failed: 0, skipped: 0 };

    for (const job of jobs || []) {
      const jid = job.id as string;
      const contractId = job.contract_id as string;
      const billingMode = (job.billing_mode as string | null) ?? "proforma_first";
      const existingStatementId = job.billing_statement_id as string | null;
      const attemptCount = (job.attempt_count as number) + 1;

      try {
        let statementId = existingStatementId;

        // ── Generate statement if not yet created ──────────────────────
        // Idempotency: if billing_statement_id is already set, skip
        // generation and go straight to dispatch (handles retries after
        // partial failures).
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

          if (genResult.alreadySent?.includes(job.contract_number as string)) {
            await admin.from("billing_dispatch_jobs").update({
              status: "skipped",
              completed_at: new Date().toISOString(),
              error_suggestion: "Already sent in a previous billing run.",
            }).eq("id", jid);
            batch.skipped++;
            continue;
          }

          // Advance-billed contract that isn't due this run. Previously this
          // fell through and the job was marked "sent" with nothing dispatched,
          // which read as a successful send in the run panel.
          if (genResult.cycleSkipped?.includes(job.contract_number as string)) {
            await admin.from("billing_dispatch_jobs").update({
              status: "skipped",
              completed_at: new Date().toISOString(),
              error_suggestion: "Bills in advance — not due this month.",
            }).eq("id", jid);
            batch.skipped++;
            continue;
          }

          if (genResult.errors?.length > 0) {
            throw new Error(genResult.errors[0]);
          }

          if (genResult.noContact?.includes(job.contract_number as string)) {
            throw new Error("No contact info — no email or phone on file");
          }

          // Statement was raised and finalized but never reached the client.
          // Fail the job so it retries and stays visible in the run panel
          // rather than reporting as a successful send.
          if (genResult.notDelivered?.includes(job.contract_number as string)) {
            throw new Error("Statement raised but dispatch failed — client never received it");
          }

          statementId = genResult.statementIds?.[0] ?? null;

          if (statementId) {
            await admin.from("billing_dispatch_jobs").update({
              billing_statement_id: statementId,
              attempt_count: attemptCount,
            }).eq("id", jid);
          }

          const dispatchedTo = genResult.statementIds?.length > 0 ? "dispatched" : null;
          await admin.from("billing_dispatch_jobs").update({
            status: "sent",
            attempt_count: attemptCount,
            dispatched_to: dispatchedTo,
            completed_at: new Date().toISOString(),
            last_error: null,
            error_suggestion: null,
          }).eq("id", jid);
          batch.sent++;
          continue;
        }

        // ── Retry path: statement exists, only redo dispatch ───────────
        const isGstDirect = billingMode === "gst_direct";

        const handoff = await handleStatementFinalized(
          admin,
          statementId,
          billingMode as "proforma_first" | "gst_direct" | null,
          "billing_dispatch_pump_retry",
        );

        let dispatchResult;
        if (handoff.skipLegacyDispatch) {
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
        batch.sent++;

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

        if (isExhausted) batch.failed++;
      }

      // Small inter-job breather — stays under Razorpay + Resend rate limits
      await new Promise((r) => setTimeout(r, 100));
    }

    totals.sent += batch.sent;
    totals.failed += batch.failed;
    totals.skipped += batch.skipped;

    const { error: incrErr } = await admin.rpc("increment_dispatch_run_counters", {
      p_run_id: run.id,
      p_sent: batch.sent + batch.skipped,
      p_failed: batch.failed,
    });
    if (incrErr) {
      await admin
        .from("billing_dispatch_runs")
        .update({
          done_jobs: (await currentDoneJobs(admin, run.id)) + batch.sent + batch.skipped,
          failed_jobs: (await currentFailedJobs(admin, run.id)) + batch.failed,
        })
        .eq("id", run.id);
    }

    await maybeCompleteRun(admin, run.id);
  }

  const { count: pendingCount } = await admin
    .from("billing_dispatch_jobs")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in("status", ["pending", "processing"]);

  return { ...totals, hasMoreWork: (pendingCount ?? 0) > 0 };
}

async function currentDoneJobs(admin: ReturnType<typeof createAdminClient>, runId: string): Promise<number> {
  const { data } = await admin.from("billing_dispatch_runs").select("done_jobs").eq("id", runId).single();
  return (data?.done_jobs as number) ?? 0;
}

async function currentFailedJobs(admin: ReturnType<typeof createAdminClient>, runId: string): Promise<number> {
  const { data } = await admin.from("billing_dispatch_runs").select("failed_jobs").eq("id", runId).single();
  return (data?.failed_jobs as number) ?? 0;
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

/**
 * Fires a non-blocking follow-up call to the pump cron endpoint so a run
 * keeps draining immediately instead of waiting for the next scheduled
 * tick. Caller must invoke this inside `after()` so it doesn't block the
 * response. Caps chain depth as a defensive guard against runaway
 * recursion — the scheduled cron is the fallback if this cap is ever hit.
 */
export async function triggerDispatchContinuation(chainDepth = 0): Promise<void> {
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    console.error(`[billing-dispatch] chain depth ${chainDepth} reached MAX_CHAIN_DEPTH — falling back to the scheduled cron tick to continue.`);
    return;
  }

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://twv-crm.vercel.app"
  ).trim();

  try {
    await fetch(`${appUrl}/api/cron/billing-dispatch-pump?chain=${chainDepth + 1}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  } catch (err) {
    console.error("[billing-dispatch] continuation trigger failed (non-fatal — scheduled cron will continue):", err instanceof Error ? err.message : err);
  }
}
