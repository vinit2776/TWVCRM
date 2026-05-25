-- Track who approved a deposit shortfall (payment within ±10% of expected amount)
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_shortfall_approved_by uuid REFERENCES users(id);
