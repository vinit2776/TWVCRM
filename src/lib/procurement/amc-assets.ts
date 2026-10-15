import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ids of the service POs that cover an asset.
 *
 * A PO can cover several assets (a combined AMC PO), with each asset on its own
 * PO line. POs created before that only have purchase_orders.linked_asset_id, so
 * both places are checked.
 */
export async function poIdsCoveringAsset(supabase: SupabaseClient, assetId: string): Promise<string[]> {
  const [direct, viaLines] = await Promise.all([
    supabase.from("purchase_orders").select("id").eq("po_type", "service").eq("linked_asset_id", assetId),
    supabase.from("purchase_order_items").select("po_id").eq("linked_asset_id", assetId),
  ]);
  return Array.from(
    new Set([
      ...(direct.data ?? []).map((r: { id: string }) => r.id),
      ...(viaLines.data ?? []).map((r: { po_id: string }) => r.po_id),
    ])
  );
}
