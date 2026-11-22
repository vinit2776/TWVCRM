-- Calendar entries for a tour: the host and the person accompanying each get the tour on their own
-- Google Calendar (the service account writes it into their calendar; nobody is emailed an invite and
-- the customer is never added). This table remembers the event created for each person so a move, a
-- change of host or a cancellation updates or removes the right one.
-- Also seeds the switch `tour_calendar_enabled` (off): no calendar entries are made until it is on.
-- Rollback:
--   DROP TABLE IF EXISTS tour_calendar_events;
--   DELETE FROM app_settings WHERE key = 'tour_calendar_enabled';

CREATE TABLE IF NOT EXISTS tour_calendar_events (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id)
);

ALTER TABLE tour_calendar_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tour_calendar_events_select" ON tour_calendar_events;
CREATE POLICY "tour_calendar_events_select" ON tour_calendar_events FOR SELECT TO authenticated USING (true);

INSERT INTO app_settings (key, value)
VALUES ('tour_calendar_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
