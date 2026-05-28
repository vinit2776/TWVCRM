-- ── Employee Access Profiles ────────────────────────────────────────────────
-- Named access policies that define:
--   • Which days are permitted (0=Sun … 6=Sat, stored as int[])
--   • Time window (from_time / until_time, NULL = no restriction)
--   • COSEC user-group number that maps to the device-side time-zone config
--
-- Physical time enforcement happens on the COSEC device via the user-group's
-- configured time-zone (set once in device admin UI). The CRM stores the
-- policy intent for visibility, reporting, and provisioning the correct group.

CREATE TABLE employee_access_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  -- allowed_days: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  allowed_days    INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
  from_time       TIME,            -- NULL = all day (no start restriction)
  until_time      TIME,            -- NULL = all day (no end restriction)
  cosec_user_group INTEGER NOT NULL DEFAULT 0 CHECK (cosec_user_group BETWEEN 0 AND 999),
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE employee_access_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read employee_access_profiles"
  ON employee_access_profiles FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "authenticated write employee_access_profiles"
  ON employee_access_profiles FOR ALL TO authenticated USING (TRUE);

-- Seed standard profiles
INSERT INTO employee_access_profiles (name, description, allowed_days, from_time, until_time, cosec_user_group, is_default)
VALUES
  ('Standard',    'Mon–Fri, 8 AM – 10 PM',  '{1,2,3,4,5}',   '08:00', '22:00', 0, TRUE),
  ('Management',  'All days, 7 AM – 11 PM', '{0,1,2,3,4,5,6}', '07:00', '23:00', 1, FALSE),
  ('24 / 7',      'Unrestricted access',    '{0,1,2,3,4,5,6}', NULL,    NULL,    2, FALSE),
  ('Weekend',     'Sat & Sun only',          '{0,6}',           '09:00', '20:00', 3, FALSE);

-- ── Extend cosec_access_users ─────────────────────────────────────────────────
-- Add: which access profile was used to provision this user
--      and an explicit valid_from date (valid_until already exists)

ALTER TABLE cosec_access_users
  ADD COLUMN IF NOT EXISTS access_profile_id UUID REFERENCES employee_access_profiles(id),
  ADD COLUMN IF NOT EXISTS valid_from DATE;

-- Index for profile lookups
CREATE INDEX IF NOT EXISTS idx_cau_access_profile
  ON cosec_access_users (access_profile_id)
  WHERE access_profile_id IS NOT NULL;
