/**
 * src/lib/tally/enqueue.ts
 *
 * Helper to enqueue a Tally sync job for a finalized billing statement.
 *
 * Called fire-and-forget from the finalize path — errors are logged but
 * never bubble up to block the API response.
 *
 * Design notes:
 *   - Idempotent: calling twice for the same statement is a no-op
 *     (idempotency_key constraint prevents duplicates).
 *   - tally_sync_enabled guard: if the master switch is off, the job is
 *     NOT queued (bridge isn't running yet / integration not live).
 *   - Payload contains taxable values ONLY — Tally computes all tax (D8).
 *     Never send pre-computed tax amounts.
 */

import { SupabaseClient } from "@supabase/supabase-js";

interface BillingStatement {
  id: string;
  total_amount: number;
  tax_percentage: number;
  subtotal: number;
  line_items: unknown;
}

export async function enqueueTallySalesVoucher(
  supabase: SupabaseClient,
  statement: BillingStatement
): Promise<void> {
  try {
    // Check master switch — don't queue if integration isn't live yet
    const { data: setting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "tally_sync_enabled")
      .single();

    if (setting?.value !== "true") {
      // Integration not yet live — silently skip
      return;
    }

    // Idempotency key: one sales_voucher job per billing statement, ever.
    const idempotencyKey = `sales_voucher:${statement.id}`;

    // Payload: taxable values + line item breakdown.
    // Tally computes CGST/SGST/IGST from its own ledger rates (D8).
    const payload = {
      billing_statement_id: statement.id,
      taxable_amount:       statement.subtotal,        // pre-tax total; Tally computes tax
      tax_percentage:       statement.tax_percentage,  // for Tally to verify ledger rates match
      line_items:           statement.line_items,      // sectioned breakdown for voucher narration
    };

    const { error } = await supabase
      .from("tally_sync_jobs")
      .insert({
        job_type:            "sales_voucher",
        billing_statement_id: statement.id,
        idempotency_key:     idempotencyKey,
        payload,
        status:              "pending",
      });

    if (error) {
      // Unique constraint violation = already queued = safe to ignore
      if (error.code === "23505") return;
      console.error("[tally/enqueue] failed to enqueue sales_voucher job:", error.message);
      return;
    }

    // Update the billing statement's sync status
    await supabase
      .from("billing_statements")
      .update({ tally_sync_status: "pending" })
      .eq("id", statement.id);

  } catch (err) {
    // Never throw — finalize must succeed regardless of Tally queue state
    console.error("[tally/enqueue] unexpected error:", err);
  }
}
