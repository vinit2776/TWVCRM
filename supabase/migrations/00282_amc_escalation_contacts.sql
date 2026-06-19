-- L2 and L3 escalation contacts for AMC service contracts
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS amc_escalation_name  TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation_phone TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation2_name  TEXT,
  ADD COLUMN IF NOT EXISTS amc_escalation2_phone TEXT;
