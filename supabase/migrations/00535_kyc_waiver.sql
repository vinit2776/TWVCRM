-- A KYC requirement that will never be collected.
--
-- Deferral was the only way to say "not now", so it became the way to say
-- "not ever". Of 242 deferred required contract documents, ~195 give a reason
-- like "Existing Client", "Active Client" or "old client" — a permanent
-- decision recorded in a field that carries an expiry date. They duly expired:
-- 131 of 134 deferrals on active contracts are past their date, which is what
-- the weekly KYC digest has been reporting as overdue every Saturday.
--
-- Waiving is separate from deferring on purpose. A deferral is a dated promise
-- and should keep nagging when it lapses. A waiver is a decision, has no date,
-- and drops out of the digest entirely — so a lapsed deferral means something
-- again.
--
-- No backfill: the existing 242 deferrals are left exactly as they are and
-- re-classified by hand, so nobody's judgement is rewritten in bulk by a
-- keyword match on a free-text reason.

-- contract_documents.status is free TEXT (see 00082) and needs no type change.
ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS waived_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waived_reason TEXT;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS waived_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waived_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_contract_docs_waived
  ON contract_documents(contract_id) WHERE status = 'waived';

CREATE INDEX IF NOT EXISTS idx_case_docs_waived
  ON case_documents(case_id) WHERE status = 'waived';

COMMENT ON COLUMN contract_documents.status IS
  'pending | uploaded | approved | rejected | deferred | waived. deferred is a dated promise that resumes chasing when deferred_until passes; waived is a permanent decision not to collect this document and never reappears in the KYC digest.';

COMMENT ON COLUMN contract_documents.waived_reason IS
  'Why this requirement will never be collected. Required when status = waived — the reason is the whole audit value of a permanent waiver.';

COMMENT ON COLUMN case_documents.waived_reason IS
  'Why this requirement will never be collected. Required when status = waived.';
