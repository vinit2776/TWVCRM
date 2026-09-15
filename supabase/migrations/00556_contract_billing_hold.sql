-- Lets admin/manager pause ALL future billing for a contract — both
-- generateRentProformas and generateUsageStatements skip a held contract
-- entirely, so no new rent proforma or usage statement is created for it
-- until the hold is released. Distinct from two existing, narrower
-- concepts:
--   - billing_statements.held_at (00543) holds one already-generated
--     statement from being sent/GST-issued; it doesn't stop new statements
--     from being generated.
--   - contract_billing_moratoriums (00310) waives one specific billing
--     month via an approval workflow; this is indefinite and needs no
--     approval — just admin/manager judgment, released whenever.
--
-- billing_hold_at IS NOT NULL is the "currently held" signal — releasing
-- nulls all three columns. Full history of who held/released and when
-- lives in audit_trail (contract_billing_held / contract_billing_hold_released),
-- same as everywhere else in this codebase; no need to preserve past holds
-- here.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS billing_hold_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_hold_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS billing_hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_contracts_billing_hold
  ON contracts (billing_hold_at)
  WHERE billing_hold_at IS NOT NULL;
