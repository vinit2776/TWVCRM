-- ============================================================
-- Migration 00602: state needed for admin rollback of purchase orders
--
-- Cancelling a PO overwrote its status and a partial cancel overwrote item
-- quantities and bill totals, with no record of what they had been — so neither
-- could be undone. This stores that state at the moment of the action, and adds
-- the RPC that restores a partial cancellation atomically.
-- ============================================================

ALTER TABLE purchase_orders
  -- Status just before a full cancel (pending/ordered/partially_received/received).
  ADD COLUMN IF NOT EXISTS status_before_cancel      TEXT  DEFAULT NULL,
  -- Everything a partial cancel changed:
  -- { status_before, total_ordered_amount,
  --   items: [{id, quantity_ordered}], bills: [{id, total_amount, payment_status}] }
  ADD COLUMN IF NOT EXISTS partial_cancel_snapshot   JSONB DEFAULT NULL;

-- ------------------------------------------------------------
-- restore_partially_cancelled_po
--
-- Puts item quantities, the PO total and its pending/rejected bills back to the
-- snapshot, under a lock on the PO. Service role only; the route checks admin
-- and that the MR still has room for the restored quantities.
--
-- Raises (route maps these to 4xx):
--   PO_NOT_FOUND, NOT_PARTIALLY_CANCELLED, NO_SNAPSHOT, BILLS_PAST_APPROVAL
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION restore_partially_cancelled_po(
  p_po_id UUID,
  p_actor UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po   purchase_orders%ROWTYPE;
  v_snap JSONB;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  IF v_po.status <> 'partially_cancelled' THEN RAISE EXCEPTION 'NOT_PARTIALLY_CANCELLED'; END IF;

  v_snap := v_po.partial_cancel_snapshot;
  IF v_snap IS NULL THEN RAISE EXCEPTION 'NO_SNAPSHOT'; END IF;

  -- One step back at a time: a bill already approved (or paid) at the reduced
  -- amount must be un-approved / reversed first, or restoring would change a
  -- figure someone signed off on.
  IF EXISTS (
    SELECT 1 FROM vendor_bills vb
    WHERE vb.po_id = p_po_id AND vb.approval_status = 'approved'
  ) THEN
    RAISE EXCEPTION 'BILLS_PAST_APPROVAL';
  END IF;

  UPDATE purchase_order_items poi
     SET quantity_ordered = x.quantity_ordered
    FROM jsonb_to_recordset(v_snap->'items') AS x(id UUID, quantity_ordered NUMERIC)
   WHERE poi.id = x.id AND poi.po_id = p_po_id;

  UPDATE vendor_bills vb
     SET total_amount   = x.total_amount,
         payment_status = x.payment_status::bill_payment_status
    FROM jsonb_to_recordset(v_snap->'bills') AS x(id UUID, total_amount NUMERIC, payment_status TEXT)
   WHERE vb.id = x.id AND vb.po_id = p_po_id
     AND vb.approval_status IN ('pending', 'rejected');

  UPDATE purchase_orders
     SET status                = COALESCE(v_snap->>'status_before', 'invoice_received')::po_status,
         total_ordered_amount  = (v_snap->>'total_ordered_amount')::NUMERIC,
         partial_cancel_snapshot = NULL
   WHERE id = p_po_id;

  RETURN jsonb_build_object(
    'po_id', p_po_id,
    'previous_status', v_po.status,
    'status', COALESCE(v_snap->>'status_before', 'invoice_received'),
    'total_ordered_amount', (v_snap->>'total_ordered_amount')::NUMERIC
  );
END;
$$;

REVOKE ALL ON FUNCTION restore_partially_cancelled_po(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION restore_partially_cancelled_po(UUID, UUID) TO service_role;
