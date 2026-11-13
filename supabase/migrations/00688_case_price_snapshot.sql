-- VO rate card wiring (W2-4, decisions D5/D6): freeze the rate card values used at quote and case
-- creation so later card edits never change existing proposals or cases. Additive and nullable.
--
-- Rollback:
--   ALTER TABLE cases DROP COLUMN IF EXISTS price_snapshot;
--   ALTER TABLE proposals DROP COLUMN IF EXISTS vo_price_snapshot;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS price_snapshot jsonb;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS vo_price_snapshot jsonb;

COMMENT ON COLUMN cases.price_snapshot IS 'Rate card guide/floor/quoted amounts and the card version used when the case was created (direct or aggregator card).';
COMMENT ON COLUMN proposals.vo_price_snapshot IS 'VO kind only: rate card purpose, location, card version, guide/floor/quoted amounts and approval requirement when the proposal was priced.';
