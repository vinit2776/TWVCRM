-- Per-line approval confirmation: an approver can decide and save an
-- individual item's approved quantity while the transfer stays
-- pending_approval, then come back later (even in a different session) to
-- keep going. The transfer as a whole can only move to "approved" once
-- every line has been explicitly confirmed.
ALTER TABLE stock_transfer_items
  ADD COLUMN approval_confirmed_at TIMESTAMPTZ,
  ADD COLUMN approval_confirmed_by UUID REFERENCES users(id);
