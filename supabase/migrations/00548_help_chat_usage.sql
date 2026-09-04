-- Per-user daily question counter for the in-app help chat assistant, used
-- to cap usage (see src/app/api/help-chat/route.ts). Only a count is stored
-- here — never the question text — since questions can contain customer PII
-- and CLAUDE.md prohibits logging that even at debug level.

CREATE TABLE IF NOT EXISTS help_chat_usage (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

ALTER TABLE help_chat_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own help_chat_usage"
  ON help_chat_usage FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Atomic increment-and-read, called from the API route with SECURITY DEFINER
-- so a normal authenticated session (not the service role) can safely bump
-- its own counter without a race between concurrent tabs/requests.
CREATE OR REPLACE FUNCTION increment_help_chat_usage(
  p_user_id UUID,
  p_day     DATE
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO help_chat_usage (user_id, day, count)
    VALUES (p_user_id, p_day, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET count = help_chat_usage.count + 1
    RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;
