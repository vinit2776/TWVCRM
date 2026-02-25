-- Sprint 3.7: Add terms_and_conditions to vendor master and purchase orders
-- Run in Supabase SQL editor after deploying the code changes.

-- Add T&C to vendor master
ALTER TABLE procurement_vendors
  ADD COLUMN IF NOT EXISTS terms_and_conditions TEXT;

-- Add payment terms + T&C to purchase orders
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(200),
  ADD COLUMN IF NOT EXISTS terms_and_conditions TEXT;
