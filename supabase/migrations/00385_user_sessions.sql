-- User activity storyboard, phase 0: session-start tracking.
-- Login events are already logged in audit_trail (entity_type='user', action='login'),
-- but ip_address/user_agent are buried in the JSONB changes column. This table promotes
-- them to first-class, indexed columns for the activity storyboard's session/trend views.
-- No ended_at/duration column: logout rarely fires cleanly (tab close, crash), so v1
-- treats this as session-start events only rather than fabricating an unreliable duration.
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address INET,
  user_agent TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_user_started ON user_sessions(user_id, started_at DESC);

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- Matches the existing team-CRM convention (see audit_trail): any authenticated user
-- can read; per-user/role access control (self vs. admin/manager) is enforced in the
-- API route, not via row-level filtering.
CREATE POLICY "auth_read" ON user_sessions FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON user_sessions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
