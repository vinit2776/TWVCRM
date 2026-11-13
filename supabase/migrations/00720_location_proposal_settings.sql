-- Per-location proposal defaults: the terms & conditions text and the commitment /
-- validity numbers a new proposal for that location starts from.
-- NULL = fall back to DEFAULT_PROPOSAL_TERMS / a blank field, so every existing
-- location behaves exactly as before until someone saves settings for it.
-- Proposals keep their own snapshot of the text; editing these never touches them.
-- locations already has RLS; no policy change needed.
-- Rollback: ALTER TABLE locations DROP COLUMN proposal_terms, DROP COLUMN proposal_defaults;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS proposal_terms text;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS proposal_defaults jsonb;
