import type { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type ReceivedItem = { quantity_ordered: number | string; quantity_received: number | string | null };

const RESTORABLE = ["pending", "ordered", "partially_received", "received"];

function receivedState(items: ReceivedItem[]): "all" | "some" | "none" {
  const some = items.some((i) => Number(i.quantity_received ?? 0) > 0);
  const all = items.length > 0 && items.every((i) => Number(i.quantity_received ?? 0) >= Number(i.quantity_ordered));
  return all ? "all" : some ? "some" : "none";
}

/**
 * Status a fully cancelled PO returns to. Uses the status stored at cancel time;
 * for POs cancelled before that was recorded, falls back to what was received,
 * and to "pending" when nothing was (the safe choice: it must be re-ordered).
 */
export function poStatusAfterCancelRestore(statusBeforeCancel: string | null, items: ReceivedItem[]): string {
  if (statusBeforeCancel && RESTORABLE.includes(statusBeforeCancel)) return statusBeforeCancel;
  const state = receivedState(items);
  return state === "all" ? "received" : state === "some" ? "partially_received" : "pending";
}

/**
 * "Marked received" with no delivery behind it: what the receipts actually
 * support. Returns null when the receipts DO cover the order — then "received"
 * is genuinely correct and the fix is to reject a delivery, not un-mark.
 */
export function poStatusAfterUnmarkReceived(items: ReceivedItem[]): string | null {
  const state = receivedState(items);
  return state === "all" ? null : state === "some" ? "partially_received" : "ordered";
}

/**
 * Would putting this PO back (un-cancel / un-partial-cancel) order more of any
 * material-request line than the MR approved, given everything else already
 * ordered? Returns a message naming the first offending line, or null if it fits.
 * `qtyByPoItem` overrides a PO item's quantity (the snapshot being restored).
 */
export async function poExceedsPrQty(
  supabase: SupabaseClient,
  poId: string,
  qtyByPoItem: Record<string, number> = {}
): Promise<string | null> {
  const { data: items } = await supabase
    .from("purchase_order_items")
    .select("id, pr_item_id, quantity_ordered")
    .eq("po_id", poId);
  const linked = (items ?? []).filter((i) => i.pr_item_id);
  if (linked.length === 0) return null;
  const prItemIds = linked.map((i) => i.pr_item_id as string);

  const [{ data: prItems }, { data: others }] = await Promise.all([
    supabase.from("purchase_request_items").select("id, quantity, item_name").in("id", prItemIds),
    supabase
      .from("purchase_order_items")
      .select("pr_item_id, quantity_ordered, purchase_orders!inner(status)")
      .in("pr_item_id", prItemIds)
      .neq("po_id", poId),
  ]);

  const consumedElsewhere: Record<string, number> = {};
  for (const row of others ?? []) {
    const ref = row.purchase_orders as unknown as { status: string } | { status: string }[];
    const status = Array.isArray(ref) ? ref[0]?.status : ref?.status;
    if (status === "cancelled") continue;
    consumedElsewhere[row.pr_item_id] = (consumedElsewhere[row.pr_item_id] ?? 0) + Number(row.quantity_ordered);
  }

  // Several PO lines can point at one MR line, so total them before comparing.
  const restoring: Record<string, number> = {};
  for (const i of linked) {
    restoring[i.pr_item_id as string] =
      (restoring[i.pr_item_id as string] ?? 0) + (qtyByPoItem[i.id] ?? Number(i.quantity_ordered));
  }

  for (const p of prItems ?? []) {
    const total = (consumedElsewhere[p.id] ?? 0) + (restoring[p.id] ?? 0);
    if (total > Number(p.quantity) + 0.0001) {
      const label = (p as { item_name?: string | null }).item_name ?? "an item";
      return `The material request only approved ${Number(p.quantity)} of ${label}, and ${consumedElsewhere[p.id] ?? 0} is already ordered on other POs — restoring this PO would over-order it.`;
    }
  }
  return null;
}

/**
 * The status an AMC returns to when a termination is reversed. Same ordering as
 * update_amc_details on the PO route: not started -> inactive, past its end ->
 * expired, visits used up -> exhausted, within 60 days of the end -> expiring.
 */
export function amcStatusFor(i: {
  start: string | null;
  end: string | null;
  visitsCovered: number | null;
  visitsUsed: number;
  today: Date;
}): "inactive" | "expired" | "exhausted" | "expiring" | "active" {
  const start = i.start ? new Date(i.start) : null;
  const end = i.end ? new Date(i.end) : null;
  if (!start || i.today < start) return "inactive";
  if (end && i.today > end) return "expired";
  if (i.visitsCovered != null && i.visitsUsed >= i.visitsCovered) return "exhausted";
  if (end) {
    const daysLeft = Math.floor((end.getTime() - i.today.getTime()) / 86_400_000);
    return daysLeft <= 60 ? "expiring" : "active";
  }
  return "active";
}
