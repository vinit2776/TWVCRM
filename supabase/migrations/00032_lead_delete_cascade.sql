-- Fix lead deletion: change ON DELETE RESTRICT → CASCADE on all tables that
-- reference leads(id). Previously these constraints blocked deleting any lead
-- that had related contracts, voucher issuances, billing statements, or
-- usage charges, causing a "Failed to delete lead" error in the UI.

-- contracts
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_lead_id_fkey;
ALTER TABLE contracts ADD CONSTRAINT contracts_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- voucher_issuances
ALTER TABLE voucher_issuances DROP CONSTRAINT IF EXISTS voucher_issuances_lead_id_fkey;
ALTER TABLE voucher_issuances ADD CONSTRAINT voucher_issuances_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- billing_statements
ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_lead_id_fkey;
ALTER TABLE billing_statements ADD CONSTRAINT billing_statements_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- usage_charges
ALTER TABLE usage_charges DROP CONSTRAINT IF EXISTS usage_charges_lead_id_fkey;
ALTER TABLE usage_charges ADD CONSTRAINT usage_charges_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
