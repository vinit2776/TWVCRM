-- Phase R1: Contract renewal flow — schema additions
--
-- Adds:
--   1. Renewal chain: parent_contract_id, is_renewal, renewal_sequence
--   2. Escalation waiver: admin-only with reason + audit
--   3. Deposit carry-forward reference + shortfall flag
--   4. Renewal communication tracking (reminder count/date)
--   5. Decline tracking (reason, who, when)

-- ── 1. Renewal chain ──────────────────────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS parent_contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_renewal         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS renewal_sequence   INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_contracts_parent
  ON contracts(parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;

COMMENT ON COLUMN contracts.parent_contract_id IS
  'Points to the previous contract in the renewal chain. NULL for first-ever contracts.';
COMMENT ON COLUMN contracts.renewal_sequence IS
  'Version number in the chain: 1 = original, 2 = first renewal, etc.';

-- ── 2. Escalation waiver ──────────────────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS escalation_waived        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS escalation_waiver_reason  TEXT,
  ADD COLUMN IF NOT EXISTS escalation_waived_by      UUID REFERENCES users(id) ON DELETE SET NULL;

-- ── 3. Deposit carry-forward ──────────────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_carried_from UUID REFERENCES contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deposit_shortfall    DECIMAL(12,2) DEFAULT 0;

COMMENT ON COLUMN contracts.deposit_carried_from IS
  'Renewal contracts: FK to the parent contract whose security deposit rolls over.';
COMMENT ON COLUMN contracts.deposit_shortfall IS
  'Difference between new deposit requirement and carried deposit. Informational only — not a hard block.';

-- ── 4. Renewal communication tracking ─────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS renewal_reminder_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_reminder_count    INTEGER DEFAULT 0;

-- ── 5. Decline tracking ───────────────────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS renewal_declined          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS renewal_declined_reason   TEXT,
  ADD COLUMN IF NOT EXISTS renewal_declined_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_declined_by       UUID REFERENCES users(id) ON DELETE SET NULL;
