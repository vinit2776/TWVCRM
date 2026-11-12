-- Special clauses for virtual-office cases (PR 2 of the special-clause feature;
-- PR 1 is 00631, which this extends).
--
-- A VO case has two agreements (the proposal and the Leave & License). The
-- clause belongs to the CASE and prints in both, so it is drafted, vetted and
-- approved once. cases.special_clause_* mirrors the current revision exactly
-- like contracts.special_clause_* does.
--
-- special_clauses now points at EITHER a contract OR a case.
--
-- Rollback:
--   ALTER TABLE special_clauses DROP CONSTRAINT IF EXISTS special_clauses_one_subject;
--   DELETE FROM special_clauses WHERE case_id IS NOT NULL;
--   ALTER TABLE special_clauses DROP COLUMN IF EXISTS case_id;
--   ALTER TABLE special_clauses ALTER COLUMN contract_id SET NOT NULL;
--   ALTER TABLE cases DROP COLUMN IF EXISTS special_clause_id,
--     DROP COLUMN IF EXISTS special_clause_text, DROP COLUMN IF EXISTS special_clause_status;

ALTER TABLE special_clauses
  ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(id) ON DELETE CASCADE;

ALTER TABLE special_clauses ALTER COLUMN contract_id DROP NOT NULL;

ALTER TABLE special_clauses
  ADD CONSTRAINT special_clauses_one_subject
  CHECK ((contract_id IS NOT NULL)::int + (case_id IS NOT NULL)::int = 1);

CREATE UNIQUE INDEX IF NOT EXISTS special_clauses_case_revision_idx
  ON special_clauses (case_id, revision) WHERE case_id IS NOT NULL;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS special_clause_status TEXT
    CHECK (special_clause_status IN ('pending_approval', 'changes_requested', 'approved')),
  ADD COLUMN IF NOT EXISTS special_clause_text TEXT,
  ADD COLUMN IF NOT EXISTS special_clause_id UUID REFERENCES special_clauses(id);
