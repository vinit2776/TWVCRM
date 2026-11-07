import type { SupabaseClient } from "@supabase/supabase-js";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { invoiceKey } from "@/lib/electricity-bill-match";

/**
 * A live bill from the same vendor with the same invoice number, ignoring case, spaces and
 * punctuation ("1033011726 " and "1033-011726" are the same invoice). Rejected and withdrawn
 * bills don't count, so a corrected resubmission is allowed. `excludeBillId` skips the bill
 * being edited.
 */
export async function findLiveDuplicateInvoice(
  supabase: SupabaseClient,
  vendorId: string,
  invoiceNumber: string | null | undefined,
  excludeBillId?: string,
): Promise<{ id: string; bill_number: string; invoice_number: string } | null> {
  const key = invoiceKey(invoiceNumber);
  if (!key) return null;
  let q = supabase
    .from("vendor_bills")
    .select("id, bill_number, invoice_number")
    .eq("vendor_id", vendorId)
    .not("invoice_number", "is", null)
    .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER)
    .limit(2000);
  if (excludeBillId) q = q.neq("id", excludeBillId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((b) => invoiceKey(b.invoice_number as string) === key);
  return hit ? { id: hit.id as string, bill_number: hit.bill_number as string, invoice_number: hit.invoice_number as string } : null;
}
