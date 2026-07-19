-- ============================================================
-- 00366: Facility Classifier telemetry (Work Orders, Phase 3)
--
-- Records what the trilingual rule classifier (src/lib/facility-classifier.ts)
-- suggested at create time, alongside what the reporter actually chose.
-- Never overrides the reporter's choice — this is purely observational until
-- Phase 4's 2-week shadow validation confirms the suggestions are trustworthy
-- enough to reveal in the UI (facility_classifier_ui_enabled flag).
--
-- user_accepted_suggestion is nullable: null means no suggestion was made
-- (confidence below threshold), not that the reporter "rejected" anything.
-- ============================================================

ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS suggested_scope facility_scope,
  ADD COLUMN IF NOT EXISTS suggested_category_id UUID REFERENCES facility_asset_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS classifier_confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS classifier_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS classifier_matched TEXT[],
  ADD COLUMN IF NOT EXISTS user_accepted_suggestion BOOLEAN,
  ADD COLUMN IF NOT EXISTS detected_language VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_facility_issues_classifier_accept
  ON facility_issues(user_accepted_suggestion)
  WHERE suggested_scope IS NOT NULL;
