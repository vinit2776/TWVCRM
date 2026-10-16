-- Proposal revisions: once a proposal has been sent, its terms are no longer
-- edited in place. "Revise" creates PROP-0231-R2 and marks the original
-- 'superseded' (links cancelled), so the customer's old PDF/link can never be
-- paid or accepted against changed terms.
--
-- proposals already has RLS enabled; no new table, so no new policy.
--
-- Rollback (superseded can't be dropped from an enum; rows using it must be
-- moved first):
--   UPDATE proposals SET status = 'rejected' WHERE status = 'superseded';
--   ALTER TABLE proposals DROP COLUMN IF EXISTS revision_of, DROP COLUMN IF EXISTS revision_number,
--     DROP COLUMN IF EXISTS superseded_by, DROP COLUMN IF EXISTS superseded_at;
--   (the unused enum value can stay)

ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'superseded';

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES proposals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES proposals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_proposals_revision_of ON proposals(revision_of) WHERE revision_of IS NOT NULL;

COMMENT ON COLUMN proposals.revision_of IS 'The proposal this one revises (the immediately previous version).';
COMMENT ON COLUMN proposals.revision_number IS '1 for an original proposal, 2 for PROP-xxxx-R2, and so on.';
COMMENT ON COLUMN proposals.superseded_by IS 'Set on the old proposal when a revision replaces it.';
