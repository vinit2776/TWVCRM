-- Virtual Office direct proposals (W2-2, decision D2): a VO kind on the existing
-- lead-bound proposals table. Every column is nullable or defaulted, and
-- kind = 'standard' leaves a proposal exactly as it was.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_proposals_vo_expiry;
--   ALTER TABLE proposals
--     DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS vo_term_months,
--     DROP COLUMN IF EXISTS vo_guide_price, DROP COLUMN IF EXISTS vo_quoted_price,
--     DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS responded_at,
--     DROP COLUMN IF EXISTS response_note, DROP COLUMN IF EXISTS withdrawn_at,
--     DROP COLUMN IF EXISTS withdrawn_reason, DROP COLUMN IF EXISTS public_token;
--
-- proposals already has RLS enabled; no new table, so no new policy. The
-- customer pages read through the service role by public_token, never by RLS.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS vo_term_months integer,
  ADD COLUMN IF NOT EXISTS vo_guide_price numeric(12, 2),
  ADD COLUMN IF NOT EXISTS vo_quoted_price numeric(12, 2),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS response_note text,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_reason text,
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN ('standard', 'virtual_office'));

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_vo_term_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_vo_term_check
  CHECK (vo_term_months IS NULL OR vo_term_months IN (11, 12, 24, 36, 48));

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_public_token ON proposals(public_token);
CREATE INDEX IF NOT EXISTS idx_proposals_vo_expiry ON proposals(expires_at)
  WHERE kind = 'virtual_office' AND status IN ('sent', 'viewed');

COMMENT ON COLUMN proposals.kind IS 'standard (lead proposal as before) or virtual_office (direct VO proposal with versions, 7-day validity, zero deposit).';
COMMENT ON COLUMN proposals.vo_term_months IS 'VO term in months: 11, 12, 24, 36 or 48.';
COMMENT ON COLUMN proposals.vo_guide_price IS 'Rate-card guide price when the proposal was written (snapshot).';
COMMENT ON COLUMN proposals.vo_quoted_price IS 'Price quoted to the customer (snapshot). For terms above 12 months this is the ANNUAL rate.';
COMMENT ON COLUMN proposals.expires_at IS 'VO kind only: the offer lapses here (7 days from sending).';
COMMENT ON COLUMN proposals.public_token IS 'Unguessable token for the customer accept page /vo-proposal/[token].';
