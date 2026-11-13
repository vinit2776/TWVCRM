import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetForAmc, AssetPurchasePo } from "@/lib/procurement/amc-received";

/**
 * Fills `purchase_po` on each asset from its soft procurement_po_id (there is no foreign
 * key), counting logged delivery challans so the receipt warning can be worked out.
 * Read-only; a failed lookup just leaves the assets without it.
 */
export async function attachPurchasePos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  assets: AssetForAmc[]
): Promise<void> {
  const poIds = Array.from(new Set(assets.map((a) => a.procurement_po_id).filter(Boolean) as string[]));
  if (poIds.length === 0) return;
  const [{ data: pos }, { data: dcs }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number, status").in("id", poIds),
    supabase.from("po_delivery_receipts").select("po_id").in("po_id", poIds),
  ]);
  const dcCount = new Map<string, number>();
  for (const d of dcs ?? []) dcCount.set(d.po_id as string, (dcCount.get(d.po_id as string) ?? 0) + 1);
  const byId = new Map<string, AssetPurchasePo>();
  for (const p of pos ?? []) {
    byId.set(p.id as string, { id: p.id as string, po_number: p.po_number as string, status: p.status as string, dc_count: dcCount.get(p.id as string) ?? 0 });
  }
  for (const a of assets) {
    if (a.procurement_po_id) a.purchase_po = byId.get(a.procurement_po_id) ?? null;
  }
}
