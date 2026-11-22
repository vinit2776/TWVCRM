-- Switch for the tour Arrivals card (today's tours with Customer arrived / Didn't come and the visit
-- report). Off by default: nothing appears on anyone's dashboard or Leads Home until it is turned on.
-- Rollback:
--   DELETE FROM app_settings WHERE key = 'tour_arrivals_enabled';
INSERT INTO app_settings (key, value)
VALUES ('tour_arrivals_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
