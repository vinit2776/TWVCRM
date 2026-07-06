-- Fix a latent bug: electricity_bills.status CHECK constraint never included
-- 'dispatched', even though POST /api/electricity-bills/[id]/dispatch has always
-- set status='dispatched' after creating the linked billing_statement. This meant
-- dispatch could never succeed on any electricity_bills row — the UPDATE would
-- always violate electricity_bills_status_check. Caught while wiring up the first
-- working Dispatch button in the UI (this route previously had no caller at all).
--
-- Pre-existing bug from 00254_electricity_sub_billing.sql — not introduced here.
--
-- Rollback:
--   ALTER TABLE electricity_bills DROP CONSTRAINT IF EXISTS electricity_bills_status_check;
--   ALTER TABLE electricity_bills ADD CONSTRAINT electricity_bills_status_check
--     CHECK (status IN ('draft', 'invoiced', 'revised'));
--   -- (only safe if no rows currently have status = 'dispatched')

ALTER TABLE electricity_bills
  DROP CONSTRAINT IF EXISTS electricity_bills_status_check;

ALTER TABLE electricity_bills
  ADD CONSTRAINT electricity_bills_status_check
    CHECK (status IN ('draft', 'invoiced', 'revised', 'dispatched'));
