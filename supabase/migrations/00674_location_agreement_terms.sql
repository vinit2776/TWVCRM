-- Per-location wording for the membership agreement's Schedule (rows 4, 6, 7).
-- NULL = the standard wording, so every existing location is unchanged until
-- someone saves terms for it. Shape: see src/lib/agreement-terms.ts.
-- locations already has RLS; no policy change needed.
-- Rollback: ALTER TABLE locations DROP COLUMN agreement_terms;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS agreement_terms jsonb;
