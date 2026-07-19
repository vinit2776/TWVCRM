-- ============================================================
-- 00367: Feature flags for the facility classifier (Work Orders, Phase 3)
--
-- Both default to false — the classifier runs and records telemetry on
-- every create regardless, but stays invisible until each flag is flipped:
--
--   facility_classifier_ui_enabled       — client-side suggestion UI
--                                          (pre-selected scope + receipt,
--                                          vague-title hint, priority nudge).
--                                          Flip only after Phase 4's 2-week
--                                          shadow-mode validation shows
--                                          >=85% agreement with what tickets
--                                          actually resolved as.
--   facility_category_autofill_enabled  — populates the always-blank
--                                          category_id from the classifier's
--                                          suggestion, which activates the
--                                          currently-dead default_assignee_id
--                                          routing (src/app/api/facility/
--                                          issues/route.ts). A real change in
--                                          who gets assigned — deserves its
--                                          own separate rollout decision from
--                                          the UI flag above.
-- ============================================================

INSERT INTO app_settings (key, value) VALUES
  ('facility_classifier_ui_enabled', 'false'),
  ('facility_category_autofill_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
