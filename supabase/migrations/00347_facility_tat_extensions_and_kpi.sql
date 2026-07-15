-- ============================================================
-- 00344: TAT/due-date extensions + KPI scoring (Work Orders + Tasks)
--
-- Extensions: self-service, up to 2 per ticket lifetime. Each carries a
-- reason category that determines whether a resulting TAT breach counts
-- against the assignee's KPI (kpi_exempt) — an override-tier "pass card"
-- can flip that determination later in either direction.
--
-- KPI: kpi_points is computed once per resolution (recomputed on
-- reopen -> re-resolve) by application code — see computeKpiPoints() in
-- src/lib/facility-kpi.ts. No formula logic lives in SQL; this migration
-- only adds the storage.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE facility_tat_reason AS ENUM (
    -- External / not the assignee's fault — exempt from KPI penalty by default
    'vendor_delay', 'awaiting_parts', 'dependent_team', 'requester_unavailable',
    -- Controllable — counts against KPI by default if still breached
    'underestimated_effort', 'competing_priorities', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_issues ADD COLUMN IF NOT EXISTS tat_extension_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facility_issues ADD COLUMN IF NOT EXISTS kpi_points NUMERIC(6,2);

CREATE TABLE IF NOT EXISTS facility_issue_tat_extensions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id            UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reason_category     facility_tat_reason NOT NULL,
  explanation         TEXT NOT NULL,
  added_hours         NUMERIC(6,2) NOT NULL CHECK (added_hours > 0),
  previous_target_at  TIMESTAMPTZ NOT NULL,
  new_target_at       TIMESTAMPTZ NOT NULL,
  kpi_exempt          BOOLEAN NOT NULL,   -- derived from reason_category at insert; can be flipped by pass card
  pass_card_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  pass_card_at        TIMESTAMPTZ,
  pass_card_note      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_tat_ext_issue ON facility_issue_tat_extensions(issue_id, created_at DESC);

ALTER TABLE facility_issue_tat_extensions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_tat_ext_select" ON facility_issue_tat_extensions;
DROP POLICY IF EXISTS "fac_tat_ext_insert" ON facility_issue_tat_extensions;
DROP POLICY IF EXISTS "fac_tat_ext_update" ON facility_issue_tat_extensions;

CREATE POLICY "fac_tat_ext_select" ON facility_issue_tat_extensions
  FOR SELECT TO authenticated USING (true);

-- Inserts happen through the app's ownership check (assignee-only), not RLS —
-- mirrors facility_issue_events/facility_issue_collaborators.
CREATE POLICY "fac_tat_ext_insert" ON facility_issue_tat_extensions
  FOR INSERT TO authenticated WITH CHECK (true);

-- Pass-card updates (kpi_exempt flip) restricted to override tier.
CREATE POLICY "fac_tat_ext_update" ON facility_issue_tat_extensions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'office_admin')
        AND is_active = true
    )
  );
