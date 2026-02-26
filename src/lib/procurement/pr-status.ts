import { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Compute consumed qty per PR item across all non-cancelled POs.
 * Fully cancelled POs contribute 0.
 * Partially_cancelled POs count their (reduced) quantity_ordered.
 */
export async function computeOrderedQtyMap(
  supabase: SupabaseClient,
  prItemIds: string[]
): Promise<Record<string, number>> {
  if (prItemIds.length === 0) return {};

  const { data: poItems } = await supabase
    .from("purchase_order_items")
    .select("pr_item_id, quantity_ordered, purchase_orders!inner(status)")
    .in("pr_item_id", prItemIds);

  const map: Record<string, number> = {};
  for (const row of poItems ?? []) {
    // Supabase returns the inner join as an array or object depending on cardinality
    const poRef = row.purchase_orders as unknown as { status: string } | { status: string }[];
    const status = Array.isArray(poRef) ? poRef[0]?.status : poRef?.status;
    if (status === "cancelled") continue;
    map[row.pr_item_id] = (map[row.pr_item_id] ?? 0) + Number(row.quantity_ordered);
  }
  return map;
}

/**
 * Recalculate and persist PR status:
 *  consumed == 0               → "approved"
 *  consumed >= total_approved  → "po_created"
 *  else                        → "partially_ordered"
 */
export async function recalculatePrStatus(
  supabase: SupabaseClient,
  prId: string
): Promise<void> {
  const { data: prItems } = await supabase
    .from("purchase_request_items")
    .select("id, quantity")
    .eq("pr_id", prId);

  if (!prItems?.length) return;

  const orderedMap = await computeOrderedQtyMap(supabase, prItems.map((i) => i.id));

  const totalApproved = prItems.reduce((s, i) => s + Number(i.quantity), 0);
  const totalConsumed = prItems.reduce((s, i) => s + (orderedMap[i.id] ?? 0), 0);

  const newStatus =
    totalConsumed <= 0 ? "approved" :
    totalConsumed >= totalApproved ? "po_created" :
    "partially_ordered";

  await supabase.from("purchase_requests").update({ status: newStatus }).eq("id", prId);
}
