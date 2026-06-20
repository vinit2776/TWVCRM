-- Add scope-of-work fields to AMC contracts (purchase_orders) and AMC MRs (purchase_requests).
-- amc_scope_covered   — what the contract covers (labour, parts, callouts, etc.)
-- amc_scope_exclusions — what is explicitly NOT covered (compressor, refrigerant gas, civil works, etc.)

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS amc_scope_covered    TEXT,
  ADD COLUMN IF NOT EXISTS amc_scope_exclusions TEXT;

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS amc_scope_covered    TEXT,
  ADD COLUMN IF NOT EXISTS amc_scope_exclusions TEXT;

COMMENT ON COLUMN purchase_orders.amc_scope_covered    IS 'What the AMC covers — e.g. quarterly PM, parts under warranty, emergency callouts';
COMMENT ON COLUMN purchase_orders.amc_scope_exclusions IS 'What the AMC does NOT cover — e.g. compressor replacement, refrigerant gas, civil works';
COMMENT ON COLUMN purchase_requests.amc_scope_covered    IS 'Copied to purchase_orders on PO creation';
COMMENT ON COLUMN purchase_requests.amc_scope_exclusions IS 'Copied to purchase_orders on PO creation';
