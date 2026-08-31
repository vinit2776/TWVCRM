-- Procurement chain cancellation — Phase 2
--
-- Phase 1 (migration 00515, commit be094214) added the ability to void a
-- single vendor bill and to reverse a single delivery receipt while
-- retaining its row for history. Both of those Phase 1 helpers
-- (src/lib/procurement/void-bill.ts, src/lib/procurement/reverse-delivery.ts)
-- write sequentially from TypeScript, with an explicit comment that a whole
-- chain (material request -> purchase orders -> vendor bills -> delivery
-- receipts) needs to cancel atomically, deferred to "Phase 2".
--
-- This migration is that follow-up. It adds:
--
--   1. procurement_cancellations — an append-only audit ledger of every
--      chain cancellation, storing the full resolved plan that was applied
--      as a point-in-time JSONB snapshot (so "what did we actually do" is
--      answerable even if the underlying rows change again later).
--
--   2. apply_procurement_cancellation(p_plan JSONB, p_actor UUID) — the
--      single writer for every cancellation/void/reversal write in this
--      feature. It re-validates the plan against live data before writing
--      anything (never trusts the caller), and runs as one PL/pgSQL
--      function body, which Postgres executes as a single transaction, so a
--      chain can never end up half-applied.
--
-- SECURITY INVOKER, not DEFINER: this function does not implement its own
-- authorization (no role checks). Authorization ("is this user allowed to
-- cancel this PR/PO/bill") is enforced in the API route layer, same as every
-- other procurement write path in this codebase. Running as SECURITY
-- DEFINER here would let any authenticated caller who can reach the RPC
-- bypass the row-level security policies on vendor_bills, purchase_orders,
-- purchase_requests, po_delivery_receipts, etc. — which is exactly what RLS
-- exists to prevent. Keeping it INVOKER (the default; simply omitting the
-- clause) means the function only ever succeeds when the calling user's own
-- RLS policies allow the writes it's making, which is the same trust
-- boundary every other write in this app already operates under.
--
-- NOTE: a processed PO advance does not get a "recovery_due" flag here — a
-- PO whose advance has already been paid out is blocked from cancellation
-- outright, enforced in the API layer that resolves and validates the plan
-- before it ever reaches this RPC. There is deliberately no
-- advance-recovery schema or write path in this migration.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS apply_procurement_cancellation(JSONB, UUID);
--   DROP TABLE IF EXISTS procurement_cancellations;
--   (procurement_cancellations is a new table, so this rollback is
--   non-destructive to any other table.)

-- =====================================================================
-- 1. procurement_cancellations — audit ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS procurement_cancellations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The entity the cancellation was initiated from — a material request, a
  -- purchase order, or a vendor bill. The RPC does not require this to be
  -- consistent with the rest of the plan; it's a label for "what did the
  -- user click cancel on", used to route this row back to the right detail
  -- page in the UI.
  root_entity_type  TEXT NOT NULL CHECK (root_entity_type IN ('purchase_request', 'purchase_order', 'vendor_bill')),
  root_entity_id    UUID NOT NULL,

  -- 'revoked'   — an approval was withdrawn; the entity returns to an
  --               editable state (e.g. a PR goes back to 'submitted').
  -- 'cancelled' — the entity is terminated outright.
  outcome           TEXT NOT NULL CHECK (outcome IN ('revoked', 'cancelled')),

  reason            TEXT NOT NULL,

  -- The full resolved plan exactly as it was applied — a point-in-time
  -- snapshot independent of whatever the referenced rows look like later
  -- (bills, POs and receipts keep changing state; this column doesn't).
  plan              JSONB NOT NULL,

  performed_by      UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procurement_cancellations_root
  ON procurement_cancellations(root_entity_type, root_entity_id);

ALTER TABLE procurement_cancellations ENABLE ROW LEVEL SECURITY;

-- Style matches recent append-only audit-adjacent tables (e.g.
-- query_attachments, 00423): a plain "authenticated" read policy with no
-- TO clause, gated on auth.uid() IS NOT NULL, plus an insert policy so the
-- SECURITY INVOKER RPC (running as the calling user, not bypassing RLS) can
-- actually write the ledger row. No UPDATE/DELETE policy — this table is
-- append-only, same as query_attachments/query_messages.
CREATE POLICY "Authenticated users can read procurement_cancellations"
  ON procurement_cancellations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert procurement_cancellations"
  ON procurement_cancellations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

COMMENT ON TABLE procurement_cancellations IS
  'Audit ledger of procurement chain cancellations applied by apply_procurement_cancellation(). Append-only; plan is a point-in-time JSONB snapshot of what was actually applied.';

-- =====================================================================
-- 2. apply_procurement_cancellation — the single writer
-- =====================================================================
--
-- Plan shape (resolved and validated by the API layer before this is
-- called; this function re-validates the parts that would be dangerous to
-- get wrong rather than trusting the caller):
--
-- {
--   "reason": "text, required",
--   "root": { "type": "purchase_request|purchase_order|vendor_bill", "id": "uuid" },
--   "outcome": "revoked|cancelled",
--   "material_request": { "id": "uuid", "terminal_status": "submitted|cancelled" } | null,
--   "purchase_orders": [{ "id": "uuid" }],
--   "vendor_bills": [{ "id": "uuid" }],
--   "delivery_receipts": [
--     { "id": "uuid", "po_id": "uuid", "stock_location_id": "uuid|null",
--       "items": [{ "po_item_id": "uuid", "stock_item_id": "uuid|null", "qty": 3, "skip_stock": false }] }
--   ]
-- }
--
-- No "advance_recoveries" key: a PO whose advance was already processed is
-- blocked from cancellation outright by the API layer before a plan is ever
-- built, so there is nothing for this RPC to flag or recover.
CREATE OR REPLACE FUNCTION apply_procurement_cancellation(
  p_plan JSONB,
  p_actor UUID
) RETURNS JSONB AS $$
DECLARE
  v_reason  TEXT := p_plan->>'reason';
  v_root_type TEXT := p_plan->'root'->>'type';
  v_root_id   UUID := (p_plan->'root'->>'id')::UUID;
  v_outcome   TEXT := p_plan->>'outcome';
  v_mr        JSONB := p_plan->'material_request';

  v_bill      JSONB;
  v_po        JSONB;
  v_receipt   JSONB;
  v_item      JSONB;

  v_bill_id   UUID;
  v_po_id     UUID;
  v_receipt_id UUID;
  v_bill_row  vendor_bills%ROWTYPE;

  v_stock_location_id UUID;
  v_stock_item_id     UUID;
  v_qty               NUMERIC;
  v_skip_stock        BOOLEAN;

  v_bills_voided     INT := 0;
  v_receipts_reversed INT := 0;
  v_pos_cancelled    INT := 0;

  v_cancellation_id UUID;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF v_reason IS NULL OR btrim(v_reason) = '' THEN
    RAISE EXCEPTION 'apply_procurement_cancellation: reason is required';
  END IF;

  IF v_root_type IS NULL OR v_root_id IS NULL THEN
    RAISE EXCEPTION 'apply_procurement_cancellation: root.type and root.id are required';
  END IF;

  IF v_outcome IS NULL OR v_outcome NOT IN ('revoked', 'cancelled') THEN
    RAISE EXCEPTION 'apply_procurement_cancellation: outcome must be revoked or cancelled';
  END IF;

  -- ===================================================================
  -- Step 1: re-validate server-side. Do NOT trust the plan.
  -- These are the last line of defence before money/stock get touched.
  -- ===================================================================

  FOR v_bill IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan->'vendor_bills', '[]'::jsonb))
  LOOP
    v_bill_id := (v_bill->>'id')::UUID;

    SELECT * INTO v_bill_row FROM vendor_bills WHERE id = v_bill_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: vendor bill % not found', v_bill_id;
    END IF;

    IF COALESCE(v_bill_row.amount_paid, 0) > 0 THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: vendor bill % has amount_paid > 0 and cannot be cancelled', v_bill_row.bill_number;
    END IF;

    IF EXISTS (SELECT 1 FROM vendor_bill_payments WHERE bill_id = v_bill_id) THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: vendor bill % has recorded payments and cannot be cancelled', v_bill_row.bill_number;
    END IF;

    IF EXISTS (SELECT 1 FROM vendor_bill_tds WHERE bill_id = v_bill_id) THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: vendor bill % has a TDS entry recorded and cannot be cancelled', v_bill_row.bill_number;
    END IF;

    IF v_bill_row.approval_status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: vendor bill % is already % and cannot be cancelled', v_bill_row.bill_number, v_bill_row.approval_status;
    END IF;
  END LOOP;

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan->'delivery_receipts', '[]'::jsonb))
  LOOP
    v_receipt_id := (v_receipt->>'id')::UUID;

    IF NOT EXISTS (SELECT 1 FROM po_delivery_receipts WHERE id = v_receipt_id) THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: delivery receipt % not found', v_receipt_id;
    END IF;

    -- The single most dangerous failure mode available in this function:
    -- reversing an already-reversed receipt would double-decrement
    -- quantity_received and location_stock, silently corrupting stock.
    IF EXISTS (
      SELECT 1 FROM po_delivery_receipts
      WHERE id = v_receipt_id AND reversed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'apply_procurement_cancellation: delivery receipt % has already been reversed', v_receipt_id;
    END IF;
  END LOOP;

  -- ===================================================================
  -- Step 2: reverse each delivery receipt.
  -- ===================================================================

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan->'delivery_receipts', '[]'::jsonb))
  LOOP
    v_receipt_id := (v_receipt->>'id')::UUID;
    v_po_id := (v_receipt->>'po_id')::UUID;
    v_stock_location_id := NULLIF(v_receipt->>'stock_location_id', '')::UUID;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_receipt->'items', '[]'::jsonb))
    LOOP
      v_qty := (v_item->>'qty')::NUMERIC;
      v_skip_stock := COALESCE((v_item->>'skip_stock')::BOOLEAN, FALSE);
      v_stock_item_id := NULLIF(v_item->>'stock_item_id', '')::UUID;

      -- Atomic decrement (floors at 0) — same RPC the delivery-reject path
      -- uses, called here rather than reimplemented.
      PERFORM increment_po_item_received(
        (v_item->>'po_item_id')::UUID,
        v_po_id,
        -v_qty
      );

      IF NOT v_skip_stock AND v_stock_location_id IS NOT NULL AND v_stock_item_id IS NOT NULL THEN
        PERFORM upsert_location_stock(v_stock_location_id, v_stock_item_id, -v_qty);
      END IF;
    END LOOP;

    -- Retain, never delete — Phase 1 (00515) established this: the receipt
    -- row survives as an auditable record that goods were genuinely
    -- received before the chain was cancelled.
    UPDATE po_delivery_receipts
    SET reversed_at = v_now,
        reversed_by = p_actor,
        reversal_reason = v_reason
    WHERE id = v_receipt_id;

    v_receipts_reversed := v_receipts_reversed + 1;
  END LOOP;

  -- ===================================================================
  -- Step 3: void each vendor bill.
  -- Field-for-field mirror of voidBill() in
  -- src/lib/procurement/void-bill.ts — do not let this drift from that
  -- function without updating both.
  -- ===================================================================

  FOR v_bill IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan->'vendor_bills', '[]'::jsonb))
  LOOP
    v_bill_id := (v_bill->>'id')::UUID;

    UPDATE vendor_bills
    SET approval_status = 'rejected',
        rejection_outcome = 'void',
        rejection_reason = v_reason,
        approved_by = p_actor,
        approved_at = v_now,
        -- Clear payment-batch scheduling — a voided bill must not show up
        -- in any upcoming payment batch.
        payment_batch_type = NULL,
        payment_batch_date = NULL,
        payment_batch_assigned_by = NULL,
        payment_batch_assigned_at = NULL,
        -- Mirror the release_hold case's field writes so a voided bill that
        -- was on hold doesn't stay stuck "on hold" forever.
        payment_hold_status = CASE WHEN payment_hold_status = 'on_hold' THEN 'none' ELSE payment_hold_status END,
        payment_hold_resolved_by = CASE WHEN payment_hold_status = 'on_hold' THEN p_actor ELSE payment_hold_resolved_by END,
        payment_hold_resolved_at = CASE WHEN payment_hold_status = 'on_hold' THEN v_now ELSE payment_hold_resolved_at END,
        payment_hold_resolution_notes = CASE WHEN payment_hold_status = 'on_hold' THEN ('Bill voided: ' || v_reason) ELSE payment_hold_resolution_notes END
    WHERE id = v_bill_id;

    -- Pause any recurring bill rule anchored to this bill — a rule anchored
    -- to a voided bill must not keep auto-approving future bills from the
    -- vendor.
    UPDATE procurement_recurring_bill_rules
    SET status = 'paused'
    WHERE anchor_bill_id = v_bill_id AND status = 'active';

    v_bills_voided := v_bills_voided + 1;
  END LOOP;

  -- ===================================================================
  -- Step 4: cancel each purchase order.
  --
  -- No advance-recovery handling here: a PO whose advance was already
  -- processed is blocked from cancellation outright by the API layer
  -- before a plan is ever built and handed to this RPC, so a PO reaching
  -- this loop is never one with an outstanding advance to flag.
  -- ===================================================================

  FOR v_po IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan->'purchase_orders', '[]'::jsonb))
  LOOP
    v_po_id := (v_po->>'id')::UUID;

    UPDATE purchase_orders
    SET status = 'cancelled'
    WHERE id = v_po_id;

    v_pos_cancelled := v_pos_cancelled + 1;
  END LOOP;

  -- ===================================================================
  -- Step 5: material request terminal status (owner of derived MR status
  -- from PO quantities remains recalculatePrStatus in TypeScript for every
  -- other flow — this just applies the terminal status the plan already
  -- decided).
  -- ===================================================================

  IF v_mr IS NOT NULL AND v_mr <> 'null'::jsonb THEN
    IF (v_mr->>'terminal_status') = 'submitted' THEN
      -- Approval revoked: clear the approval fields so the MR re-enters the
      -- approval queue clean.
      UPDATE purchase_requests
      SET status = 'submitted'::pr_status,
          approved_by = NULL,
          approved_at = NULL,
          approval_code = NULL
      WHERE id = (v_mr->>'id')::UUID;
    ELSE
      -- Cancelled: leave the approval fields as the historical record.
      UPDATE purchase_requests
      SET status = (v_mr->>'terminal_status')::pr_status
      WHERE id = (v_mr->>'id')::UUID;
    END IF;
  END IF;

  -- ===================================================================
  -- Step 6: insert the audit ledger row.
  -- ===================================================================

  INSERT INTO procurement_cancellations (
    root_entity_type, root_entity_id, outcome, reason, plan, performed_by
  ) VALUES (
    v_root_type, v_root_id, v_outcome, v_reason, p_plan, p_actor
  )
  RETURNING id INTO v_cancellation_id;

  -- ===================================================================
  -- Step 7: return a summary.
  -- ===================================================================

  RETURN jsonb_build_object(
    'cancellation_id', v_cancellation_id,
    'bills_voided', v_bills_voided,
    'receipts_reversed', v_receipts_reversed,
    'purchase_orders_cancelled', v_pos_cancelled
  );
END;
$$ LANGUAGE plpgsql SET search_path = public;
-- No SECURITY DEFINER clause above — this intentionally runs as SECURITY
-- INVOKER (the PL/pgSQL default). See the header comment for why.

GRANT EXECUTE ON FUNCTION apply_procurement_cancellation(JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION apply_procurement_cancellation(JSONB, UUID) TO service_role;
