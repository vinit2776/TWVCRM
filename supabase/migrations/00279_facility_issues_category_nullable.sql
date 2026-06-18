-- Make category_id optional on facility_issues.
-- Reporters now pick scope (IT, HVAC, etc.) — the granular category
-- is assigned during triage by the first responder.

ALTER TABLE facility_issues
  ALTER COLUMN category_id DROP NOT NULL;
