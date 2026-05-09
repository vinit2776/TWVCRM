-- Persistent in-app notifications (independent of browser push).
-- Each row = one notification for one user.
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,              -- e.g. 'facility_created', 'facility_comment', 'facility_assigned', 'facility_status'
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  url         TEXT,                       -- deep-link path, e.g. '/facility/issues/uuid'
  entity_type TEXT,                       -- e.g. 'facility_issue'
  entity_id   UUID,                       -- the issue / entity UUID
  read_at     TIMESTAMPTZ,               -- NULL = unread
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notif_user_created
  ON notifications (user_id, created_at DESC);

-- Enable Supabase Realtime on the notifications table
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
