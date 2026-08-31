import { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Pure fallback resolution for which location a delivery's stock should be
 * reversed against. Extracted so the fallback chain can be pinned with a
 * unit test — getting this wrong would silently reverse stock at the wrong
 * location.
 *
 * Order of preference:
 * 1. The value stored on the receipt at creation time (`stock_location_id`)
 *    — this is the value that was actually used to CREDIT stock, so it's
 *    always the correct one to reverse against when present.
 * 2. The PO's own `location_id` — re-derived for legacy receipts recorded
 *    before `stock_location_id` was captured on the receipt row.
 * 3. The linked Purchase Request's `location_id` — POs don't always have a
 *    location selected directly; the PR they were raised from usually does.
 */
export function resolveStockLocationId(
  receiptStockLocationId: string | null | undefined,
  poLocationId: string | null | undefined,
  prLocationId: string | null | undefined
): string | null {
  return receiptStockLocationId ?? poLocationId ?? prLocationId ?? null;
}

/**
 * Pure fallback resolution for which catalogue item a delivery line's stock
 * should be reversed against. Extracted so the fallback chain can be pinned
 * with a unit test — getting this wrong would silently corrupt stock for an
 * unrelated item.
 *
 * Order of preference:
 * 1. The value stored on the receipt item at creation time (`stock_item_id`)
 *    — this is the exact item stock was credited to, so it's always correct
 *    when present.
 * 2. The PO item's own `item_id` — re-derived for legacy receipt items
 *    recorded before `stock_item_id` was captured on the receipt item row.
 * 3. The linked Purchase Request item's `item_id` — PO items don't always
 *    have a catalogue item_id set directly; the PR item they came from
 *    usually does.
 */
export function resolveStockItemId(
  receiptItemStockItemId: string | null | undefined,
  poItemItemId: string | null | undefined,
  prItemItemId: string | null | undefined
): string | null {
  return receiptItemStockItemId ?? poItemItemId ?? prItemItemId ?? null;
}

type ReverseDeliveryResult = { ok: true } | { ok: false; error: string };

/**
 * A receipt is "live" — its stock/quantity_received effect still stands —
 * exactly when `reversed_at` is unset. Extracted as a pure predicate so
 * "is this receipt already reversed" can be pinned with a unit test: this is
 * the single check standing between a normal reversal and silently
 * double-decrementing stock, so it must not be re-derived ad hoc at each
 * call site or reader.
 */
export function isReceiptLive(reversedAt: string | null | undefined): boolean {
  return reversedAt == null;
}

/**
 * Pure validation for what `reverseDeliveryReceipt` needs before it's safe to
 * write anything: the "retain" disposition must never write a
 * half-populated reversal (no actor, no reason), and an already-reversed
 * receipt must never be reversed again regardless of disposition. Extracted
 * so both guard conditions can be pinned with a unit test independent of a
 * Supabase client.
 */
export function validateReversalRequest(opts: {
  disposition: "delete" | "retain";
  reversedBy?: string | null;
  reason?: string | null;
  currentReversedAt: string | null | undefined;
}): { ok: true } | { ok: false; error: string } {
  if (!isReceiptLive(opts.currentReversedAt)) {
    return { ok: false, error: "This delivery receipt has already been reversed" };
  }
  if (opts.disposition === "retain" && (!opts.reversedBy || !opts.reason?.trim())) {
    return {
      ok: false,
      error: "reversedBy and reason are required to retain a reversed delivery receipt",
    };
  }
  return { ok: true };
}

/**
 * Reverses a single delivery receipt: decrements `quantity_received` on each
 * affected PO item, reverses the matching `location_stock` credit (skipping
 * catalogue items typed "service", which never had a stock write to reverse
 * in the first place), then either deletes the receipt's line items and the
 * receipt row (`disposition: "delete"`), or leaves them in place and stamps
 * the reversal columns (`disposition: "retain"`).
 *
 * This is the exact reversal logic proven in the delivery-rejection path
 * (`DELETE /api/procurement/orders/[id]/deliveries`), extracted so the
 * force-cancel path can reuse it verbatim instead of re-deriving the
 * fallback chains. Do NOT change the stock/quantity_received math here
 * without updating both callers' expectations — see reasoning in
 * `resolveStockLocationId` / `resolveStockItemId` above for why each
 * fallback exists.
 *
 * `disposition` decides what happens to the receipt row afterwards:
 * - "delete": deletes `po_delivery_receipt_items` then `po_delivery_receipts`
 *   — behaves exactly as this helper always has. Used by the delivery-reject
 *   path, which is correcting an erroneous entry, not recording history.
 * - "retain": keeps both rows and stamps `reversed_at`/`reversed_by`/
 *   `reversal_reason` on the receipt so the challan survives as an auditable
 *   record of goods that were genuinely received before the PO was
 *   cancelled. `reversedBy` and `reason` are required for this path — a
 *   half-populated reversal (e.g. no reason) is refused rather than written.
 *
 * A receipt that is already reversed (`reversed_at IS NOT NULL`) is refused
 * outright, for both dispositions — reversing it again would double-decrement
 * `quantity_received` and `location_stock`, silently corrupting stock.
 *
 * PO-status recomputation is intentionally NOT done here — it stays at each
 * call site, since the two callers need different recomputation strategies
 * (the reject path recomputes from remaining quantities after a single
 * receipt; the force-cancel path reverses ALL receipts and then forces
 * status to "cancelled" regardless, so per-receipt recomputation there would
 * be wasted work and could momentarily write a misleading status).
 */
export async function reverseDeliveryReceipt(
  supabase: SupabaseClient,
  opts: {
    receiptId: string;
    poId: string;
    /** "delete" removes the receipt rows (delivery-reject correction).
     *  "retain" keeps them and stamps the reversal columns (PO cancellation). */
    disposition: "delete" | "retain";
    reversedBy?: string;
    reason?: string;
  }
): Promise<ReverseDeliveryResult> {
  const { receiptId, poId, disposition, reversedBy, reason } = opts;

  // Fail fast on the reason/actor requirement before any DB round-trip — the
  // already-reversed half of the guard needs the receipt row, so it's
  // re-checked (via the same pure validator) once that's fetched below.
  const upfrontCheck = validateReversalRequest({
    disposition,
    reversedBy,
    reason,
    currentReversedAt: null,
  });
  if (!upfrontCheck.ok) {
    return upfrontCheck;
  }

  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, pr_id, location_id")
    .eq("id", poId)
    .single();
  if (poErr || !po) {
    return { ok: false, error: "Purchase order not found" };
  }

  // Fetch delivery receipt + items (including the stock location/item
  // resolved and stored at creation time)
  const { data: receipt, error: receiptErr } = await supabase
    .from("po_delivery_receipts")
    .select("*, po_delivery_receipt_items(id, po_item_id, qty_received, stock_item_id)")
    .eq("id", receiptId)
    .eq("po_id", poId)
    .single();

  if (receiptErr || !receipt) {
    return { ok: false, error: "Delivery receipt not found" };
  }

  // Guard against double reversal — reversing an already-reversed receipt
  // would decrement quantity_received and location_stock a second time,
  // silently corrupting stock. This is the most dangerous bug available in
  // this change, so it's checked explicitly against the value just read from
  // the DB rather than relying on the caller to never do this twice.
  const guardCheck = validateReversalRequest({
    disposition,
    reversedBy,
    reason,
    currentReversedAt: receipt.reversed_at,
  });
  if (!guardCheck.ok) {
    return guardCheck;
  }

  // Resolve the location to reverse stock at. Prefer the value stored on the
  // receipt when it was recorded; for legacy receipts (before it was stored)
  // re-derive with the SAME fallback chain the POST path uses: PO's
  // location_id, else the linked Purchase Request's location_id.
  let prLocationId: string | null = null;
  if (!receipt.stock_location_id && !po.location_id && po.pr_id) {
    const { data: prRow } = await supabase
      .from("purchase_requests")
      .select("location_id")
      .eq("id", po.pr_id)
      .maybeSingle();
    prLocationId = prRow?.location_id ?? null;
  }
  const stockLocationId = resolveStockLocationId(
    receipt.stock_location_id,
    po.location_id,
    prLocationId
  );

  if (disposition === "delete") {
    // Delivery-reject correction path — unchanged by Phase 2. This is NOT
    // part of the RPC: deletion is not something apply_procurement_cancellation
    // does (it only ever retains/stamps receipts), and the delivery-reject
    // path's behaviour must not shift.
    for (const item of receipt.po_delivery_receipt_items ?? []) {
      const { data: poItem } = await supabase
        .from("purchase_order_items")
        .select("item_id, quantity_received, purchase_request_items(item_id)")
        .eq("id", item.po_item_id)
        .eq("po_id", poId)
        .single();
      if (poItem) {
        // Atomic decrement (floors at 0) — mirrors the POST-path increment
        await supabase.rpc("increment_po_item_received", {
          p_po_item_id: item.po_item_id,
          p_po_id: poId,
          p_delta: -Number(item.qty_received),
        });
        // Reverse location_stock against the item stock was credited to:
        // stored stock_item_id, else re-derive via the POST path's fallback
        // (PO item's item_id, else the linked PR item's item_id).
        const stockItemId = resolveStockItemId(
          item.stock_item_id,
          poItem.item_id,
          (poItem.purchase_request_items as unknown as { item_id: string | null } | null)?.item_id
        );
        if (stockLocationId && stockItemId) {
          // Services never had a location_stock write in the first place — skip the reversal too.
          const { data: catalogRow } = await supabase
            .from("procurement_items")
            .select("item_type")
            .eq("id", stockItemId)
            .maybeSingle();
          if (catalogRow?.item_type !== "service") {
            await supabase.rpc("upsert_location_stock", {
              p_location_id: stockLocationId,
              p_item_id: stockItemId,
              p_quantity_delta: -Number(item.qty_received),
            });
          }
        }
      }
    }

    // Delete receipt items, then receipt
    await supabase.from("po_delivery_receipt_items").delete().eq("delivery_receipt_id", receiptId);
    await supabase.from("po_delivery_receipts").delete().eq("id", receiptId).eq("po_id", poId);

    return { ok: true };
  }

  // disposition === "retain" (Phase 2, migration 00516): build a one-receipt
  // cancellation plan — resolving the same location/item fallback chains as
  // before — and hand the actual writes (decrement quantity_received,
  // reverse location_stock, stamp reversed_at/reversed_by/reversal_reason)
  // to apply_procurement_cancellation, the single writer for this feature.
  const items = (receipt.po_delivery_receipt_items ?? []).map(
    (item: { id: string; po_item_id: string; qty_received: number; stock_item_id: string | null }) => {
      return { item, poItemId: item.po_item_id, qty: Number(item.qty_received) };
    }
  );

  const resolvedItems: Array<{
    po_item_id: string;
    stock_item_id: string | null;
    qty: number;
    skip_stock: boolean;
  }> = [];

  for (const { item, poItemId, qty } of items) {
    const { data: poItem } = await supabase
      .from("purchase_order_items")
      .select("item_id, purchase_request_items(item_id)")
      .eq("id", poItemId)
      .eq("po_id", poId)
      .single();

    const stockItemId = poItem
      ? resolveStockItemId(
          item.stock_item_id,
          poItem.item_id,
          (poItem.purchase_request_items as unknown as { item_id: string | null } | null)?.item_id
        )
      : null;

    let skipStock = !stockLocationId || !stockItemId;
    if (!skipStock && stockItemId) {
      const { data: catalogRow } = await supabase
        .from("procurement_items")
        .select("item_type")
        .eq("id", stockItemId)
        .maybeSingle();
      if (catalogRow?.item_type === "service") {
        skipStock = true;
      }
    }

    resolvedItems.push({
      po_item_id: poItemId,
      stock_item_id: stockItemId,
      qty,
      skip_stock: skipStock,
    });
  }

  const plan = {
    reason,
    root: { type: "purchase_order" as const, id: poId },
    outcome: "cancelled" as const,
    material_request: null,
    purchase_orders: [],
    vendor_bills: [],
    delivery_receipts: [
      {
        id: receiptId,
        po_id: poId,
        stock_location_id: stockLocationId,
        items: resolvedItems,
      },
    ],
    advance_recoveries: [],
  };

  const { error: rpcError } = await supabase.rpc("apply_procurement_cancellation", {
    p_plan: plan,
    p_actor: reversedBy,
  });

  if (rpcError) {
    return { ok: false, error: `Stock was not reversed: ${rpcError.message}` };
  }

  return { ok: true };
}
