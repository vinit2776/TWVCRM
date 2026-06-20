-- AMC termination
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the ability to terminate an AMC contract mid-term. Terminated contracts
-- stay as read-only records — their logged service events stay visible forever
-- as part of the asset's institutional memory. To resume AMC coverage, admin
-- creates a new PO through the unified MR flow; there is no un-terminate.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS amc_terminated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amc_terminated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amc_termination_reason TEXT;

-- Extend the amc_status CHECK constraint to allow 'terminated'
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_amc_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_amc_status_check
  CHECK (amc_status IN ('inactive','active','expiring','exhausted','expired','terminated'));

COMMENT ON COLUMN purchase_orders.amc_terminated_at IS
  'Set when AMC is terminated mid-contract. Once set, no new service events should be logged. Use a new PO to resume AMC.';
COMMENT ON COLUMN purchase_orders.amc_termination_reason IS
  'Required when amc_terminated_at is set. Free text — surfaces on the PO and the asset AMC tab as institutional memory.';
