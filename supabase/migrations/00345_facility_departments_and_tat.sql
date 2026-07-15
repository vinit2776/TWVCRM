-- ============================================================
-- 00342: Facility Departments + TAT (Work Orders, Phase 1)
--
-- Departments map 1:1 onto the existing facility_scope enum values
-- (it/hvac/plumbing/electrical/housekeeping/security/other/facility).
-- Each department has an optional head_user_id, used to auto-assign
-- new Work Orders when the category has no more-specific
-- default_assignee_id set. facility_department_members is a plain
-- roster (informational only — does not restrict who can claim or
-- be assigned a ticket).
--
-- TAT is the existing SLA engine (sla_target_at/sla_breached),
-- rebranded and exposed for manual override. tat_hours records the
-- duration actually used (auto-computed from category defaults, or
-- manually set); tat_manual_override marks that a manual value should
-- survive a later priority change instead of being silently recomputed.
-- ============================================================

CREATE TABLE IF NOT EXISTS facility_departments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             facility_scope NOT NULL UNIQUE,
  head_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER update_facility_departments_updated_at
    BEFORE UPDATE ON facility_departments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_dept_select" ON facility_departments;
DROP POLICY IF EXISTS "fac_dept_write"  ON facility_departments;

CREATE POLICY "fac_dept_select" ON facility_departments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_dept_write" ON facility_departments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_team')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_team')
        AND is_active = true
    )
  );

-- One department per existing scope value. Heads start unassigned —
-- admin configures them from /facility/settings.
INSERT INTO facility_departments (scope)
  VALUES ('it'), ('hvac'), ('electrical'), ('plumbing'),
         ('housekeeping'), ('security'), ('other'), ('facility')
ON CONFLICT (scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Table: facility_department_members (roster only — no access restriction)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_department_members (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id     UUID NOT NULL REFERENCES facility_departments(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_fac_dept_members_dept ON facility_department_members(department_id);

ALTER TABLE facility_department_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_dept_members_select" ON facility_department_members;
DROP POLICY IF EXISTS "fac_dept_members_write"  ON facility_department_members;

CREATE POLICY "fac_dept_members_select" ON facility_department_members
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_dept_members_write" ON facility_department_members
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_team')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_team')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- TAT columns on facility_issues
-- ---------------------------------------------------------------------------

ALTER TABLE facility_issues ADD COLUMN IF NOT EXISTS tat_hours NUMERIC(6,2);
ALTER TABLE facility_issues ADD COLUMN IF NOT EXISTS tat_manual_override BOOLEAN NOT NULL DEFAULT false;
