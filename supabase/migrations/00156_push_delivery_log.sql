-- Push delivery tracking — one row per (broadcast, subscription).
-- Web Push has no native read receipt, so we instrument:
--   • server logs sent/failed at send time
--   • SW beacons "delivered" when the push event fires
--   • SW beacons "clicked" when the user taps the notification
-- This gives us reach (delivered) + engagement (clicked).

CREATE TABLE IF NOT EXISTS push_delivery_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      UUID         NOT NULL,
  user_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  endpoint      TEXT         NOT NULL,
  payload       JSONB        NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'queued',
                             -- queued | sent | failed | delivered | clicked
  error_code    INT,
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  clicked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_delivery_log_batch_idx
  ON push_delivery_log(batch_id);

CREATE INDEX IF NOT EXISTS push_delivery_log_batch_endpoint_idx
  ON push_delivery_log(batch_id, endpoint);

CREATE INDEX IF NOT EXISTS push_delivery_log_user_idx
  ON push_delivery_log(user_id, created_at DESC);

-- Service role manages this table; RLS off to keep beacon endpoint simple
-- (the /api/push/track route uses the admin client and validates batch_id +
-- endpoint together so anonymous spoofing requires guessing both).
ALTER TABLE push_delivery_log ENABLE ROW LEVEL SECURITY;
