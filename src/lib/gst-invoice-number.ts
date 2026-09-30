import type { SupabaseClient } from "@supabase/supabase-js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Today's date in IST as YYYY-MM-DD.
 *
 * Invoice and payment dates must be IST calendar dates. `toISOString()` is UTC,
 * so anything issued between 00:00 and 05:30 IST was dated the previous day —
 * which on the 1st lands in the previous GST return period, and on 1 April in
 * the previous financial year.
 */
export function istTodayYmd(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** GST invoice number prefix for the Indian FY (Apr–Mar, IST) containing `now`, e.g. "TWV/INV/26-27/". */
export function gstInvoiceFyPrefix(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const fyStart = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `TWV/INV/${String(fyStart).slice(-2)}-${String(fyStart + 1).slice(-2)}/`;
}

/**
 * Allocate the next GST tax invoice number for the current FY.
 *
 * Goes through the next_gst_invoice_number RPC (migration 00570), which bumps a
 * per-FY counter under a row lock, so concurrent issuances can never get the
 * same number. The old COUNT(existing)+1 could, and lagged behind the highest
 * issued number whenever one was cleared. Throws if the RPC fails — issuing a
 * tax invoice without a guaranteed-unique number is worse than not issuing it.
 */
export async function allocateGstInvoiceNumber(
  adminSupabase: SupabaseClient,
  now: Date = new Date(),
): Promise<string> {
  const { data, error } = await adminSupabase.rpc("next_gst_invoice_number", {
    p_fy_prefix: gstInvoiceFyPrefix(now),
  });
  if (error || typeof data !== "string" || !data) {
    throw new Error(`Could not allocate GST invoice number: ${error?.message ?? "empty response"}`);
  }
  return data;
}
