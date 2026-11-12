-- Marks vendors that supply services (internet, AMC, security, ...) rather than
-- goods. Used by the goods PO form to warn when a service vendor is picked, so
-- service contracts go through the service PO flow instead of Delivery Received
-- + challan with quantities. Defaults to false; admins/managers toggle it on the
-- vendor profile. The existing RLS policies on procurement_vendors cover it.
ALTER TABLE procurement_vendors
  ADD COLUMN IF NOT EXISTS is_service_provider BOOLEAN NOT NULL DEFAULT FALSE;

-- Rollback: ALTER TABLE procurement_vendors DROP COLUMN is_service_provider;
