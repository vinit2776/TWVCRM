-- Switch for the overdue review (leads whose next step is 14+ days past due, with Snooze, Set a new
-- date and Close as no response). 'dry_run' shows the review and previews each action without
-- changing anything; 'live' applies them; 'off' hides it. Starts as a preview.
-- Rollback:
--   DELETE FROM app_settings WHERE key = 'lead_overdue_review_mode';
INSERT INTO app_settings (key, value)
VALUES ('lead_overdue_review_mode', 'dry_run')
ON CONFLICT (key) DO NOTHING;
