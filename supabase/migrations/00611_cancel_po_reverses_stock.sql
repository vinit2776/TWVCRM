-- ============================================================
-- Migration 00611: cancelling a PO with received goods now reverses its stock
--
-- BUG: force-cancelling a PO that had received goods flipped the PO to
-- 'cancelled' but never took the goods back out of location_stock, leaving
-- phantom inventory. Rejecting a single delivery already reversed stock; the
-- PO-level cancel did not.
--
-- FIX: cancel_po_reversing_receipts() does the whole cancel atomically — for
-- every standing delivery receipt it deducts the stock that was credited (never
-- below zero), returns the received quantity on the PO lines, and flags the
-- receipt REVERSED (kept for history, like a voided payment). It records how
-- much stock it actually took (stock_reversed_qty) so restore_cancelled_po()
-- can put back exactly that and no more — a shortfall caused by goods consumed
-- in the meantime must not turn into phantom stock in the other direction.
--
-- Stock location / item are resolved with the same fallbacks the delivery route
-- used when crediting: receipt.stock_location_id -> PO.location_id ->
-- MR.location_id; receipt item.stock_item_id -> PO item -> MR item. Services
-- never carried stock and are skipped.
-- ============================================================

ALTER TABLE po_delivery_receipts
  ADD COLUMN IF NOT EXISTS reversed_at     TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reversed_by     UUID        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT        DEFAULT NULL;

-- How much stock the reversal really deducted (NULL = nothing, e.g. a service).
ALTER TABLE po_delivery_receipt_items
  ADD COLUMN IF NOT EXISTS stock_reversed_qty NUMERIC DEFAULT NULL;

-- ------------------------------------------------------------
-- cancel_po_reversing_receipts
-- Raises: PO_NOT_FOUND, PO_NOT_CANCELLABLE, BILLS_EXIST
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_po_reversing_receipts(
  p_po_id  UUID,
  p_actor  UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po        purchase_orders%ROWTYPE;
  v_pr_loc    UUID;
  r           RECORD;
  ri          RECORD;
  v_loc       UUID;
  v_item      UUID;
  v_type      TEXT;
  v_on_hand   NUMERIC;
  v_take      NUMERIC;
  v_receipts  INT := 0;
  v_units     NUMERIC := 0;
  v_deducted  NUMERIC := 0;
  v_short     JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  IF v_po.status::text NOT IN ('pending', 'ordered', 'partially_received', 'received') THEN
    RAISE EXCEPTION 'PO_NOT_CANCELLABLE';
  END IF;
  -- A bill (other than a withdrawn one) means the cycle is invoiced; the route
  -- tells the user to withdraw it first.
  IF EXISTS (SELECT 1 FROM vendor_bills WHERE po_id = p_po_id AND approval_status <> 'withdrawn') THEN
    RAISE EXCEPTION 'BILLS_EXIST';
  END IF;

  IF v_po.pr_id IS NOT NULL THEN
    SELECT location_id INTO v_pr_loc FROM purchase_requests WHERE id = v_po.pr_id;
  END IF;

  FOR r IN
    SELECT * FROM po_delivery_receipts
     WHERE po_id = p_po_id AND reversed_at IS NULL
     ORDER BY received_at
  LOOP
    v_loc := COALESCE(r.stock_location_id, v_po.location_id, v_pr_loc);

    FOR ri IN
      SELECT i.id, i.po_item_id, i.qty_received, i.stock_item_id,
             poi.item_id AS poi_item_id, pri.item_id AS pri_item_id
        FROM po_delivery_receipt_items i
        JOIN purchase_order_items poi ON poi.id = i.po_item_id
        LEFT JOIN purchase_request_items pri ON pri.id = poi.pr_item_id
       WHERE i.delivery_receipt_id = r.id
    LOOP
      v_item := COALESCE(ri.stock_item_id, ri.poi_item_id, ri.pri_item_id);
      v_take := NULL;

      IF v_loc IS NOT NULL AND v_item IS NOT NULL THEN
        SELECT item_type INTO v_type FROM procurement_items WHERE id = v_item;
        IF COALESCE(v_type, '') <> 'service' THEN
          SELECT quantity_on_hand INTO v_on_hand
            FROM location_stock
           WHERE location_id = v_loc AND item_id = v_item
             FOR UPDATE;
          v_take := LEAST(COALESCE(v_on_hand, 0), ri.qty_received);
          IF v_take > 0 THEN
            UPDATE location_stock
               SET quantity_on_hand = quantity_on_hand - v_take, last_updated = now()
             WHERE location_id = v_loc AND item_id = v_item;
            v_deducted := v_deducted + v_take;
          END IF;
          -- Goods already consumed can't be taken back out; say so, don't block.
          IF v_take < ri.qty_received THEN
            v_short := v_short || jsonb_build_object('item_id', v_item, 'short', ri.qty_received - v_take);
          END IF;
        END IF;
      END IF;

      UPDATE po_delivery_receipt_items
         SET stock_reversed_qty = v_take,
             stock_item_id = COALESCE(stock_item_id, v_item)
       WHERE id = ri.id;

      UPDATE purchase_order_items
         SET quantity_received = GREATEST(0, COALESCE(quantity_received, 0) - ri.qty_received)
       WHERE id = ri.po_item_id;

      v_units := v_units + ri.qty_received;
    END LOOP;

    UPDATE po_delivery_receipts
       SET reversed_at = now(), reversed_by = p_actor, reversal_reason = p_reason,
           stock_location_id = COALESCE(stock_location_id, v_loc)
     WHERE id = r.id;
    v_receipts := v_receipts + 1;
  END LOOP;

  UPDATE purchase_orders
     SET status = 'cancelled', status_before_cancel = v_po.status::text
   WHERE id = p_po_id;

  RETURN jsonb_build_object(
    'previous_status', v_po.status::text,
    'receipts_reversed', v_receipts,
    'units_received_returned', v_units,
    'stock_deducted', v_deducted,
    'shortfalls', v_short
  );
END;
$$;

-- ------------------------------------------------------------
-- restore_cancelled_po
-- Un-cancels a PO: puts back exactly the stock the cancel took, re-credits the
-- received quantities, un-flags the receipts, and sets the PO's status. The
-- status is computed by the caller (src/lib/procurement/po-rollback.ts).
-- Raises: PO_NOT_FOUND, NOT_CANCELLED
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION restore_cancelled_po(
  p_po_id  UUID,
  p_actor  UUID,
  p_status TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po        purchase_orders%ROWTYPE;
  r           RECORD;
  ri          RECORD;
  v_receipts  INT := 0;
  v_restored  NUMERIC := 0;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  IF v_po.status::text <> 'cancelled' THEN RAISE EXCEPTION 'NOT_CANCELLED'; END IF;

  FOR r IN
    SELECT * FROM po_delivery_receipts WHERE po_id = p_po_id AND reversed_at IS NOT NULL
  LOOP
    FOR ri IN
      SELECT id, po_item_id, qty_received, stock_item_id, stock_reversed_qty
        FROM po_delivery_receipt_items WHERE delivery_receipt_id = r.id
    LOOP
      IF COALESCE(ri.stock_reversed_qty, 0) > 0 AND r.stock_location_id IS NOT NULL AND ri.stock_item_id IS NOT NULL THEN
        PERFORM upsert_location_stock(r.stock_location_id, ri.stock_item_id, ri.stock_reversed_qty);
        v_restored := v_restored + ri.stock_reversed_qty;
      END IF;
      UPDATE purchase_order_items
         SET quantity_received = COALESCE(quantity_received, 0) + ri.qty_received
       WHERE id = ri.po_item_id;
      UPDATE po_delivery_receipt_items SET stock_reversed_qty = NULL WHERE id = ri.id;
    END LOOP;

    UPDATE po_delivery_receipts
       SET reversed_at = NULL, reversed_by = NULL, reversal_reason = NULL
     WHERE id = r.id;
    v_receipts := v_receipts + 1;
  END LOOP;

  UPDATE purchase_orders
     SET status = p_status::po_status, status_before_cancel = NULL
   WHERE id = p_po_id;

  RETURN jsonb_build_object('receipts_restored', v_receipts, 'stock_restored', v_restored, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION cancel_po_reversing_receipts(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION restore_cancelled_po(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cancel_po_reversing_receipts(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION restore_cancelled_po(UUID, UUID, TEXT) TO service_role;
