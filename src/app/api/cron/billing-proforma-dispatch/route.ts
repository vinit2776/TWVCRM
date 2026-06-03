import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

/**
 * GET /api/cron/billing-proforma-dispatch
 *
 * Scheduled trigger: auto-sends proforma invoices on the LAST day of each
 * calendar month to every finalized billing statement that hasn't had a
 * proforma sent yet.
 *
 * Cron fires at 21:30 IST on days 28–31 (vercel.json: "0 16 28-31 * *").
 * The handler verifies it is actually the last day of the month (IST) before
 * dispatching — same guard used by /api/billing/auto-generate.
 *
 * Manual ad-hoc sending (accounts exception) is handled via the UI button
 * which calls POST /api/billing-statements/[id]/send-proforma directly.
 *
 * Query: ?force=1  — skip the last-day guard (for testing / manual backfill)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "1";

  // Last-day-of-month guard (IST)
  if (!force) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + IST_OFFSET_MS);
    const todayDate = nowIST.getUTCDate();
    const daysInMonth = new Date(nowIST.getUTCFullYear(), nowIST.getUTCMonth() + 1, 0).getDate();

    if (todayDate !== daysInMonth) {
      return NextResponse.json({
        skipped: true,
        reason: `Not last day of month (day ${todayDate} of ${daysInMonth})`,
      });
    }
  }

  const adminSupabase = createAdminClient();

  // Batch size: process at most 30 statements per cron run to stay well within
  // Vercel's 60 s maxDuration. Each self-call takes ~1-2 s (Razorpay + Resend).
  // Remaining unsent statements are picked up on the next cron run.
  const BATCH_SIZE = 30;
  // Max concurrent dispatch calls — keeps wall-clock time low without
  // hammering Razorpay/Resend simultaneously.
  const CONCURRENCY = 5;

  // Fetch finalized statements that haven't had proforma sent (bounded)
  const { data: statements, error } = await adminSupabase
    .from("billing_statements")
    .select("id, statement_number, contract_id")
    .eq("status", "finalized")
    .is("proforma_sent_at", null)
    .is("gst_invoice_number", null)
    .not("contract_id", "is", null) // only contract-linked statements
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[proforma-dispatch] Failed to fetch statements:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!statements || statements.length === 0) {
    await pingCronHealth("billing-proforma-dispatch");
    return NextResponse.json({ dispatched: 0, message: "No pending finalized statements" });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  const cronSecret = process.env.CRON_SECRET || "";

  const results: Array<{ id: string; number: string; ok: boolean; result?: unknown; error?: string }> = [];

  // Process in concurrent batches of CONCURRENCY to reduce total wall-clock time
  // while avoiding overwhelming external APIs (Razorpay, Resend, MSG91).
  for (let i = 0; i < statements.length; i += CONCURRENCY) {
    const batch = statements.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (stmt) => {
        try {
          const res = await fetch(`${appUrl}/api/billing-statements/${stmt.id}/send-proforma`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": cronSecret,
            },
            body: JSON.stringify({ skipAuth: true }),
          });

          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            console.error(`[proforma-dispatch] Failed for ${stmt.statement_number}:`, json);
          }
          return { id: stmt.id, number: stmt.statement_number, ok: res.ok, result: json };
        } catch (err) {
          console.error(`[proforma-dispatch] Error for ${stmt.statement_number}:`, err);
          return { id: stmt.id, number: stmt.statement_number, ok: false, error: String(err) };
        }
      })
    );
    results.push(...batchResults);
  }

  await pingCronHealth("billing-proforma-dispatch");

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json({
    dispatched: statements.length,
    succeeded,
    failed,
    results,
  });
}
