-- Track which internal user manually recorded a deposit payment (bank transfer),
-- so the "Security Deposit" card can show who booked it, not just when.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_payment_recorded_by uuid REFERENCES users(id);
