import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Committed AMC spend for a financial year.
 *
 * Shared by the AMC register banner and the material-request budget strip, which
 * previously computed this independently and could therefore disagree on screen.
 *
 * "Committed" is approved-and-beyond requests, minus any whose purchase orders
 * were all cancelled: cancelling a PO does not move its request out of 'approved',
 * so without this those requests keep consuming budget for work that will never
 * happen. A request with no PO yet still counts — it is approved spend awaiting
 * an order, not abandoned.
 */
export async function computeAmcCommitted(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  fyStart: string,
  fyEnd: string,
  companyId: string
): Promise<number> {
  const { data: requests, error } = await supabase
    .from("purchase_requests")
    .select("id, total_estimated_amount")
    .eq("company_id", companyId)
    .eq("expenditure_type", "amc")
    .gte("created_at", fyStart)
    .lte("created_at", fyEnd)
    .in("status", ["approved", "partially_ordered", "po_created"]);

  if (error) {
    console.error("[amc budget] committed spend query failed:", error.message);
    return 0;
  }
  if (!requests?.length) return 0;

  const { data: pos, error: posError } = await supabase
    .from("purchase_orders")
    .select("pr_id, status")
    .in("pr_id", requests.map((r) => r.id));
  if (posError) console.error("[amc budget] committed PO query failed:", posError.message);

  return requests.reduce((sum, req) => {
    const linked = (pos ?? []).filter((po) => po.pr_id === req.id);
    const allCancelled = linked.length > 0 && linked.every((po) => po.status === "cancelled");
    return allCancelled ? sum : sum + Number(req.total_estimated_amount ?? 0);
  }, 0);
}
