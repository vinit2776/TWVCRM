-- Per-person progress through the in-app renewal guidance (guidance G3).
--
-- Explanations on the renewal screens are long the first few times someone does
-- a step and shrink once they have done it a few times; a failed action brings
-- the long version back. That needs to follow the PERSON, not the browser: staff
-- share devices at the front desk, so browser storage would mix people up.
--
-- One row per (person, step). `step_key` names a renewal step ("renewal.start")
-- or a one-off such as the first-time walkthrough ("walkthrough.renewals").
-- Holds no customer data. Each person can read only their own rows; writes go
-- through record_guidance_event(), which only the service role can call.
--
-- Rollback:
--   DROP FUNCTION record_guidance_event(UUID, TEXT, TEXT);
--   DROP TABLE user_guidance_progress;

CREATE TABLE user_guidance_progress (
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_key          text        NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 80),
  times_completed   integer     NOT NULL DEFAULT 0 CHECK (times_completed >= 0),
  last_completed_at timestamptz,
  last_blocked_at   timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, step_key)
);

ALTER TABLE user_guidance_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_guidance_progress_own_select" ON user_guidance_progress
  FOR SELECT TO authenticated
  USING (user_id = (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Counts a completion or notes a blocked attempt in one statement, so two
-- quick clicks cannot lose a count.
CREATE FUNCTION record_guidance_event(p_user_id UUID, p_step_key TEXT, p_event TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_event = 'completed' THEN
    INSERT INTO user_guidance_progress (user_id, step_key, times_completed, last_completed_at)
    VALUES (p_user_id, p_step_key, 1, now())
    ON CONFLICT (user_id, step_key) DO UPDATE
      SET times_completed = user_guidance_progress.times_completed + 1,
          last_completed_at = now(),
          updated_at = now();
  ELSIF p_event = 'blocked' THEN
    INSERT INTO user_guidance_progress (user_id, step_key, last_blocked_at)
    VALUES (p_user_id, p_step_key, now())
    ON CONFLICT (user_id, step_key) DO UPDATE
      SET last_blocked_at = now(),
          updated_at = now();
  ELSE
    RAISE EXCEPTION 'Unknown guidance event %', p_event;
  END IF;
END;
$$;

-- Supabase grants execute to anon and authenticated by default; a SECURITY DEFINER
-- function that takes a user id must not be callable by them.
REVOKE ALL ON FUNCTION record_guidance_event(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_guidance_event(UUID, TEXT, TEXT) TO service_role;
