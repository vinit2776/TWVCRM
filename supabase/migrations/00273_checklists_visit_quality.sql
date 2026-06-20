-- Phase 4: Checklists & Visit Quality

-- 1. Checklist templates per asset category (optionally scoped to event type)
CREATE TABLE IF NOT EXISTS facility_checklist_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES facility_asset_categories(id) ON DELETE CASCADE,
  event_type  TEXT,  -- null = applies to all event types; or 'preventive','breakdown', etc.
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_checklist_templates_category ON facility_checklist_templates(category_id);

ALTER TABLE facility_checklist_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "checklist_templates_select" ON facility_checklist_templates
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "checklist_templates_manage" ON facility_checklist_templates
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users u WHERE u.auth_id = auth.uid() AND u.role IN ('admin','manager','fms'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM users u WHERE u.auth_id = auth.uid() AND u.role IN ('admin','manager','fms'))
  );

-- 2. Per-visit checklist items (linked to a service event)
CREATE TABLE IF NOT EXISTS amc_event_checklist_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES amc_service_events(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  checked     BOOLEAN NOT NULL DEFAULT false,
  notes       TEXT,
  is_custom   BOOLEAN NOT NULL DEFAULT false,  -- true = added ad-hoc during this visit
  checked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  checked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_checklist_event ON amc_event_checklist_items(event_id);

ALTER TABLE amc_event_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_checklist_select" ON amc_event_checklist_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "event_checklist_manage" ON amc_event_checklist_items
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users u WHERE u.auth_id = auth.uid()
      AND u.role IN ('admin','manager','fms','accounts','office_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM users u WHERE u.auth_id = auth.uid()
      AND u.role IN ('admin','manager','fms','accounts','office_admin'))
  );

-- 3. Visit confirmation columns on amc_service_events
ALTER TABLE amc_service_events
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
