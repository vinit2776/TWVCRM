-- VO terms library wiring (W2-5): snapshot columns plus the switch that turns the wiring on.
-- Additive. With vo_terms_library_mode = 'off' (the default) nothing reads or writes these.
--
-- Rollback:
--   ALTER TABLE proposals DROP COLUMN IF EXISTS vo_terms_snapshot;
--   ALTER TABLE cases DROP COLUMN IF EXISTS vo_terms_snapshot;
--   DELETE FROM app_settings WHERE key = 'vo_terms_library_mode';

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS vo_terms_snapshot jsonb;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS vo_terms_snapshot jsonb;

COMMENT ON COLUMN proposals.vo_terms_snapshot IS 'VO kind only: exact library clause ids, versions and rendered text sent with the proposal, so later library edits never change it.';
COMMENT ON COLUMN cases.vo_terms_snapshot IS 'Exact library clause ids, versions and rendered text printed in the latest generated agreement for this case.';

INSERT INTO app_settings (key, value) VALUES ('vo_terms_library_mode', 'off')
  ON CONFLICT (key) DO NOTHING;
