-- 00262_bill_069_backfill_audit_explanation.sql
--
-- The previous PR (00261) reset PO-2606-086's advance back to pending and
-- unwound BILL-2606-069's ₹49,000 pre-credit via raw SQL — no `logAudit()`
-- ran, so the bill's audit timeline showed an unexplained drop of
-- amount_paid from 49,000 to 0. This stamps an explanatory row on both
-- entities so the timeline reads truthfully:
--   "Advance pre-credit reversed — re-routed through Finance for proper
--    UTR capture"
--
-- Idempotent: only inserts if the target bill exists AND we haven't
-- already stamped this explanation (matched by an exact action string).

DO $$
DECLARE
  v_bill_id UUID;
  v_po_id   UUID;
BEGIN
  SELECT id INTO v_bill_id FROM vendor_bills    WHERE bill_number = 'BILL-2606-069';
  SELECT id INTO v_po_id   FROM purchase_orders WHERE po_number   = 'PO-2606-086';

  -- BILL side
  IF v_bill_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM audit_trail
      WHERE entity_type = 'vendor_bill'
        AND entity_id   = v_bill_id
        AND action      = 'backfill_advance_reversed'
    ) THEN
      INSERT INTO audit_trail (entity_type, entity_id, action, changes, performed_by, created_at)
      VALUES (
        'vendor_bill',
        v_bill_id,
        'backfill_advance_reversed',
        jsonb_build_object(
          'reason',          jsonb_build_object('old', NULL, 'new', 'PO advance pre-credit reversed — re-routed through Finance for proper UTR capture'),
          'amount_paid',     jsonb_build_object('old', 49000, 'new', 0),
          'payment_status',  jsonb_build_object('old', 'partially_paid', 'new', 'unpaid'),
          'pr_reference',    jsonb_build_object('old', NULL, 'new', 'PR #104')
        ),
        NULL,
        NOW()
      );
    END IF;
  END IF;

  -- PO side
  IF v_po_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM audit_trail
      WHERE entity_type = 'purchase_order'
        AND entity_id   = v_po_id
        AND action      = 'backfill_advance_reset'
    ) THEN
      INSERT INTO audit_trail (entity_type, entity_id, action, changes, performed_by, created_at)
      VALUES (
        'purchase_order',
        v_po_id,
        'backfill_advance_reset',
        jsonb_build_object(
          'reason',         jsonb_build_object('old', NULL, 'new', 'Advance reset to pending — re-routed through Finance for proper UTR capture'),
          'advance_status', jsonb_build_object('old', 'processed', 'new', 'pending'),
          'pr_reference',   jsonb_build_object('old', NULL, 'new', 'PR #104')
        ),
        NULL,
        NOW()
      );
    END IF;
  END IF;
END $$;
