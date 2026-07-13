-- ============================================================
-- 00338: task_recurrence_rules
--
-- Phase 1 of the Internal Tasks plan (recurring delegation). A rule is
-- a template ("assign X to Aruna every 1st of the month"); the cron at
-- /api/cron/facility-recurring-tasks spawns real facility_issues rows
-- (task_type = 'recurring_instance') from it on schedule.
--
-- v1 scope, matching the one-time delegation model already shipped:
-- category-less (no task_categories dependency), single fixed
-- assignee per rule (no rotation), any active user can create a rule
-- for themselves — no location-scoped authorization (see
-- canDelegateTo() in src/lib/facility.ts for why that was dropped).
-- ============================================================

CREATE TABLE task_recurrence_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  assigned_to     UUID NOT NULL REFERENCES users(id),
  priority        facility_issue_priority NOT NULL DEFAULT 'medium',

  cadence_type    TEXT NOT NULL CHECK (cadence_type IN ('daily', 'weekly', 'monthly')),
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),   -- 0=Sunday, required for weekly
  day_of_month    SMALLINT CHECK (day_of_month BETWEEN 1 AND 31), -- required for monthly
  CONSTRAINT task_recurrence_rules_cadence_fields CHECK (
    (cadence_type = 'daily') OR
    (cadence_type = 'weekly' AND day_of_week IS NOT NULL) OR
    (cadence_type = 'monthly' AND day_of_month IS NOT NULL)
  ),

  -- If the previous spawned instance is still open, skip this cycle
  -- rather than piling up duplicates. Per-rule so a category where
  -- pile-up is fine (e.g. reminders) can opt out later if needed.
  skip_if_open    BOOLEAN NOT NULL DEFAULT true,
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_by      UUID NOT NULL REFERENCES users(id),
  last_spawned_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_recurrence_rules_active ON task_recurrence_rules(is_active);
CREATE INDEX idx_task_recurrence_rules_assigned_to ON task_recurrence_rules(assigned_to);

ALTER TABLE task_recurrence_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_recurrence_rules_select" ON task_recurrence_rules
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "task_recurrence_rules_insert" ON task_recurrence_rules
  FOR INSERT TO authenticated WITH CHECK (
    created_by IN (SELECT id FROM public.users WHERE auth_id = auth.uid() AND is_active = true)
  );

CREATE POLICY "task_recurrence_rules_update" ON task_recurrence_rules
  FOR UPDATE TO authenticated USING (
    created_by IN (SELECT id FROM public.users WHERE auth_id = auth.uid() AND is_active = true)
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager', 'office_admin') AND is_active = true
    )
  );

CREATE POLICY "task_recurrence_rules_delete" ON task_recurrence_rules
  FOR DELETE TO authenticated USING (
    created_by IN (SELECT id FROM public.users WHERE auth_id = auth.uid() AND is_active = true)
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid() AND role IN ('admin', 'manager', 'office_admin') AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- facility_issues.recurrence_rule_id — links a spawned instance back to
-- the rule that created it (used by the cron's skip_if_open guard).
-- ---------------------------------------------------------------------------

ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS recurrence_rule_id UUID REFERENCES task_recurrence_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fac_issues_recurrence_rule ON facility_issues(recurrence_rule_id)
  WHERE recurrence_rule_id IS NOT NULL;
