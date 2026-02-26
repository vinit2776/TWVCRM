-- Push notification subscriptions table
-- Stores Web Push API subscriptions (one per user per browser/device).
-- Used to send OS-level push notifications when new enquiries arrive.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID         REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT         NOT NULL,
  p256dh     TEXT         NOT NULL,
  auth       TEXT         NOT NULL,
  created_at TIMESTAMPTZ  DEFAULT now(),
  -- One subscription per (user, browser endpoint) — upsert-safe
  UNIQUE(user_id, endpoint)
);

-- Fast lookup when broadcasting to all subscribed users
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions(user_id);

-- Allow the service role to read/write; authenticated users manage their own rows
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own push subscriptions"
  ON push_subscriptions
  FOR ALL
  USING (
    user_id = (
      SELECT id FROM users WHERE auth_id = auth.uid() LIMIT 1
    )
  );
