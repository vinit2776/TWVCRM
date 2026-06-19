-- Advance payment approval gate — mirrors vendor bill approval_status.
-- Admin must approve before accounts can process the payment.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS advance_approval_status TEXT
    CHECK (advance_approval_status IN ('pending_review', 'approved', 'rejected'));

-- Backfill: existing pending advances become pending_review
UPDATE purchase_orders
  SET advance_approval_status = 'pending_review'
  WHERE advance_amount > 0
    AND advance_status = 'pending'
    AND advance_approval_status IS NULL;
