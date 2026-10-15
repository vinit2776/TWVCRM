import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ids of the live service POs that cover an asset.
 *
 * A PO can cover several assets (a combined AMC PO), with each asset on its own
 * PO line. POs created before that only have purchase_orders.linked_asset_id, so
 * both places are checked.
 *
 * Cancelled POs are left out: cancelling never touches a PO's stored amc_status
 * or dates, so without this filter a cancelled contract keeps looking like an
 * active AMC to every reader built on this lookup (QR page, vendor upload, the
 * asset's AMC tab, the issue page).
 */
export async function poIdsCoveringAsset(supabase: SupabaseClient, assetId: string): Promise<string[]> {
  const [direct, viaLines] = await Promise.all([
    supabase.from("purchase_orders").select("id").eq("po_type", "service").eq("linked_asset_id", assetId),
    supabase.from("purchase_order_items").select("po_id").eq("linked_asset_id", assetId),
  ]);
  const candidates = Array.from(
    new Set([
      ...(direct.data ?? []).map((r: { id: string }) => r.id),
      ...(viaLines.data ?? []).map((r: { po_id: string }) => r.po_id),
    ])
  );
  if (candidates.length === 0) return [];

  const { data: live } = await supabase
    .from("purchase_orders")
    .select("id")
    .in("id", candidates)
    .eq("po_type", "service")
    .neq("status", "cancelled");
  return (live ?? []).map((r: { id: string }) => r.id);
}
