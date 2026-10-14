-- ============================================================================
-- 00570: stop signed-in users from changing their own role
-- ============================================================================
-- 00001 created:
--   CREATE POLICY "auth_update" ON users FOR UPDATE USING (auth.uid() IS NOT NULL);
--   CREATE POLICY "auth_insert" ON users FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
-- so any session holding the public anon key could run
--   supabase.from("users").update({ role: "admin" })
-- against any row, including its own, and every role check in the app reads
-- users.role. The INSERT policy let a signed-in user with no users row insert
-- one with any role.
--
-- Who legitimately writes to users:
--   * handle_new_user() trigger      — SECURITY DEFINER, bypasses RLS
--   * /api/team, /api/team/[id], /api/users/[id] (admin role/status/profile
--     changes)                       — service-role client, bypasses RLS
--   * /settings page                 — own row, full_name + phone
--   * /api/auth/login-audit          — own row, last_login_at
--
-- So: users may update only their own row, only the profile columns below, and
-- nobody inserts through the anon key. Service role and SECURITY DEFINER paths
-- are unaffected.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS users_guard_self_update ON users;
--   DROP FUNCTION IF EXISTS users_guard_self_update();
--   DROP POLICY IF EXISTS "users_update_own_profile" ON users;
--   CREATE POLICY "auth_insert" ON users FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
--   CREATE POLICY "auth_update" ON users FOR UPDATE USING (auth.uid() IS NOT NULL);
-- ============================================================================

DROP POLICY IF EXISTS "auth_insert" ON users;
DROP POLICY IF EXISTS "auth_update" ON users;
DROP POLICY IF EXISTS "users_update_own_profile" ON users;

CREATE POLICY "users_update_own_profile" ON users
  FOR UPDATE TO authenticated
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid());

-- RLS can't restrict columns, so a trigger enforces the allowlist. It is an
-- allowlist rather than a "role/is_active" denylist so a column added later is
-- locked by default. It only fires for PostgREST's end-user roles; service_role,
-- postgres and SECURITY DEFINER functions pass through untouched.
CREATE OR REPLACE FUNCTION users_guard_self_update()
RETURNS TRIGGER AS $$
DECLARE
  self_editable CONSTANT text[] := ARRAY['full_name', 'phone', 'avatar_url', 'last_login_at', 'updated_at'];
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (to_jsonb(NEW) - self_editable) IS DISTINCT FROM (to_jsonb(OLD) - self_editable) THEN
    RAISE EXCEPTION 'Only full_name, phone and avatar_url can be changed on your own user record'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS users_guard_self_update ON users;
CREATE TRIGGER users_guard_self_update
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_self_update();
