-- ============================================================
-- Migration 00373: Transfer quantity chain (requested/approved/sent)
-- ------------------------------------------------------------
-- Splits the single quantity_sent field into three stages so that
-- a shortfall at any stage is visible and final rather than silently
-- collapsed into one number:
--   quantity_requested — set by the requester at creation, immutable
--   quantity_approved  — set by the approver, editable down from requested
--   quantity_sent      — set by the issuer at dispatch, editable down from
--                        approved (existing column; now populated at
--                        dispatch time instead of creation time)
--
-- Existing rows (already past creation) had quantity_sent set at
-- creation time under the old model — backfill requested/approved from
-- it so historical transfers still read correctly.
--
-- Rollback: drop quantity_requested, quantity_approved, approver_notes.
-- ============================================================

ALTER TABLE stock_transfer_items
  ADD COLUMN IF NOT EXISTS quantity_requested NUMERIC,
  ADD COLUMN IF NOT EXISTS quantity_approved NUMERIC;

UPDATE stock_transfer_items
SET quantity_requested = quantity_sent,
    quantity_approved  = quantity_sent
WHERE quantity_requested IS NULL;

ALTER TABLE stock_transfer_items
  ALTER COLUMN quantity_requested SET NOT NULL;

-- Approver's message back to the requester — separate from the
-- requester's own `notes` on stock_transfers so approve/reject can no
-- longer overwrite it.
ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS approver_notes TEXT;
