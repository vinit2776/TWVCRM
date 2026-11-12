-- Special clauses: a customer-specific paragraph printed in one contract's
-- agreement (Clause 37 "Special Conditions"), drafted and AI-vetted by the
-- author, then approved by a manager/admin. Every revision is kept.
--
-- contracts.special_clause_* is a denormalised copy of the CURRENT revision so
-- the agreement PDF, the send/sign gate and badges need no join:
--   special_clause_status  NULL                -> no special clause
--                          'pending_approval'  -> awaiting manager/admin (gates sending)
--                          'changes_requested' -> sent back to the author (gates sending)
--                          'approved'          -> special_clause_text prints in the agreement
--
-- Rollback (nothing else depends on these):
--   ALTER TABLE contracts DROP COLUMN IF EXISTS special_clause_id,
--     DROP COLUMN IF EXISTS special_clause_text, DROP COLUMN IF EXISTS special_clause_status;
--   DROP TABLE IF EXISTS special_clauses;

CREATE TABLE IF NOT EXISTS special_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  revision INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending_approval', 'approved', 'changes_requested', 'withdrawn', 'superseded')),
  intent TEXT NOT NULL,          -- what the author asked for, in their words
  reason TEXT NOT NULL,          -- why (internal; never printed)
  clause_text TEXT NOT NULL,     -- the AI-drafted wording that prints
  ai_report JSONB,               -- kept / added / conflict-check findings
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,            -- approver's reason when requesting changes
  required_changes TEXT,         -- what the author must correct
  self_approved BOOLEAN NOT NULL DEFAULT FALSE,
  carried_from_id UUID REFERENCES special_clauses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, revision)
);

CREATE INDEX IF NOT EXISTS special_clauses_contract_idx ON special_clauses (contract_id, revision DESC);
CREATE INDEX IF NOT EXISTS special_clauses_pending_idx ON special_clauses (status) WHERE status = 'pending_approval';

ALTER TABLE special_clauses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "special_clauses_select" ON special_clauses
  FOR SELECT TO authenticated USING (true);

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS special_clause_status TEXT
    CHECK (special_clause_status IN ('pending_approval', 'changes_requested', 'approved')),
  ADD COLUMN IF NOT EXISTS special_clause_text TEXT,
  ADD COLUMN IF NOT EXISTS special_clause_id UUID REFERENCES special_clauses(id);
