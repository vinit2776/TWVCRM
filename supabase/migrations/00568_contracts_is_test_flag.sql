-- ============================================================
-- Migration 00568: Flag known test contracts so real financial
-- reports/dashboards can exclude them.
--
-- These 5 contracts were created while testing the proposal -> contract
-- flow in production and have no real customer or payment attached.
-- Flagging (not deleting) keeps them fully usable for future testing
-- while removing their fake billing/usage data from reporting totals.
-- ============================================================

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS is_test_contract BOOLEAN NOT NULL DEFAULT false;

UPDATE contracts
SET is_test_contract = true
WHERE contract_number IN (
  'TWV-C-0001',
  'TWV-C-0002',
  'TWV-C-0112',
  'TWV-C-0113',
  'TWV-C-0136'
);
