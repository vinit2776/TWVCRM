import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * getLastReceivedMap — for a location, the most recent inward date per item_id,
 * combining PO delivery receipts and received stock transfers. Used to estimate
 * stock age ("days since last received"). No lot tracking exists, so this is the
 * newest inward — real age of lingering stock may be older.
 *
 * Returns Map<item_id, ISO date string>.
 */
export async function getLastReceivedMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, "public", any>,
  locationId: string
): Promise<Map<string, string>> {
  const lastReceived = new Map<string, string>();
  const bump = (itemId: string | null | undefined, date: string | null | undefined) => {
    if (!itemId || !date) return;
    const prev = lastReceived.get(itemId);
    if (!prev || date > prev) lastReceived.set(itemId, date);
  };

  // ── PO deliveries (GRN) ────────────────────────────────────────────────
  const { data: pos } = await supabase
    .from("purchase_orders")
    .select("id")
    .eq("location_id", locationId);
  const poIds = (pos ?? []).map((p: { id: string }) => p.id);

  if (poIds.length > 0) {
    const { data: receipts } = await supabase
      .from("po_delivery_receipts")
      .select("received_at, po_delivery_receipt_items(po_item:purchase_order_items(item_id))")
      .in("po_id", poIds)
      .not("received_at", "is", null);

    for (const r of (receipts ?? []) as unknown as {
      received_at: string;
      po_delivery_receipt_items: { po_item: { item_id: string | null } | null }[];
    }[]) {
      for (const li of r.po_delivery_receipt_items ?? []) {
        bump(li.po_item?.item_id, r.received_at);
      }
    }
  }

  // ── Received transfers into this location ──────────────────────────────
  const { data: transfers } = await supabase
    .from("stock_transfers")
    .select("received_at, stock_transfer_items(item_id)")
    .eq("to_location_id", locationId)
    .not("received_at", "is", null);

  for (const t of (transfers ?? []) as unknown as {
    received_at: string;
    stock_transfer_items: { item_id: string | null }[];
  }[]) {
    for (const it of t.stock_transfer_items ?? []) {
      bump(it.item_id, t.received_at);
    }
  }

  return lastReceived;
}

/** Whole-days between an ISO date and now (floored, min 0). */
export function ageInDays(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}
