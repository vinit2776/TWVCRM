-- AMC and other service contracts can be billed half-yearly, not just monthly,
-- quarterly or yearly. Two things blocked that value from ever being stored:
--
--   1. purchase_orders.billing_cycle carries a CHECK constraint that listed only
--      monthly / quarterly / yearly.
--   2. A service PO writes one representative line item whose unit names the
--      cycle ('month', 'quarter', 'year'), and item_unit had no half-year value.
--
-- BILLING_CYCLE_MONTHS and BILLING_CYCLE_LABELS already knew about 'half_yearly'
-- from the contract side, so only the storage layer needed widening.

ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'half_year';

ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_billing_cycle_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_billing_cycle_check
  CHECK (billing_cycle IN ('monthly', 'quarterly', 'half_yearly', 'yearly'));
