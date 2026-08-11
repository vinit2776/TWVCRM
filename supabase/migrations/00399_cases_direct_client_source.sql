-- Introduce "direct" (no-aggregator) Virtual Office clients. Previously every
-- case required an aggregator (aggregator_id NOT NULL). Direct clients come to
-- TWV without a referral partner and are billed directly.
--
-- Also add case_bill_to: for aggregator-sourced, prepaid cases, whether the
-- per-case invoice should be billed to the aggregator or the end client varies
-- case by case (not a fixed rule per aggregator) — set explicitly when the
-- case's invoice is generated. Not applicable to postpaid (always billed to
-- the aggregator, consolidated) or direct cases (always billed to the client).

CREATE TYPE case_source AS ENUM ('aggregator', 'direct');
CREATE TYPE case_bill_to AS ENUM ('aggregator', 'client');

ALTER TABLE cases
  ALTER COLUMN aggregator_id DROP NOT NULL;

ALTER TABLE cases
  ADD COLUMN case_source case_source NOT NULL DEFAULT 'aggregator',
  ADD COLUMN bill_to case_bill_to;

-- Explicit, idempotent backfill (no-op given the default + prior NOT NULL,
-- written for clarity).
UPDATE cases SET case_source = 'aggregator' WHERE aggregator_id IS NOT NULL;

ALTER TABLE cases
  ADD CONSTRAINT cases_source_aggregator_consistency CHECK (
    (case_source = 'direct' AND aggregator_id IS NULL) OR
    (case_source = 'aggregator' AND aggregator_id IS NOT NULL)
  );

CREATE INDEX idx_cases_case_source ON cases(case_source);

COMMENT ON COLUMN cases.case_source IS 'Whether this case was referred by an aggregator or came direct from the client.';
COMMENT ON COLUMN cases.bill_to IS 'For prepaid-aggregator cases only: who the per-case invoice bills. Set explicitly per case, no default.';
