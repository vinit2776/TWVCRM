-- ============================================================
-- 00116: Facility Issues Module (Phase 1 — IT focus)
--
-- Tracks issues raised against facility infrastructure (IT first,
-- but schema is generic so HVAC / plumbing / electrical etc. drop
-- in by adding category rows).
--
-- Tables:
--   facility_asset_categories  (seeded list, e.g. UDM, Switch, AP)
--   facility_assets            (individual physical devices)
--   facility_issues            (the tickets)
--   facility_issue_attachments (photos / docs)
--   facility_issue_events      (per-issue activity timeline)
--
-- Plus a private storage bucket for attachments.
-- Purely additive — no existing tables are modified.
-- ============================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE facility_scope AS ENUM (
    'it', 'hvac', 'plumbing', 'electrical', 'housekeeping', 'security', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE facility_issue_priority AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE facility_issue_status AS ENUM (
    'new', 'acknowledged', 'in_progress', 'resolved', 'closed', 'reopened'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE facility_root_cause AS ENUM (
    'hardware_failure', 'config_issue', 'isp_outage',
    'power_issue', 'user_error', 'scheduled_maintenance',
    'wear_and_tear', 'environmental', 'unknown', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE facility_reported_via AS ENUM (
    'walk_in', 'phone', 'whatsapp', 'email',
    'self_service', 'proactive', 'feedback'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE facility_asset_status AS ENUM ('active', 'maintenance', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Table: facility_asset_categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_asset_categories (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                       facility_scope NOT NULL,
  name                        VARCHAR(120) NOT NULL,
  slug                        VARCHAR(60)  NOT NULL UNIQUE,
  icon                        VARCHAR(60),                       -- lucide icon name
  description                 TEXT,
  -- Default SLA targets (resolution hours) — overridable per-issue
  default_sla_critical_hrs    NUMERIC(6,2) NOT NULL DEFAULT 2,
  default_sla_high_hrs        NUMERIC(6,2) NOT NULL DEFAULT 8,
  default_sla_medium_hrs      NUMERIC(6,2) NOT NULL DEFAULT 24,
  default_sla_low_hrs         NUMERIC(6,2) NOT NULL DEFAULT 72,
  sort_order                  INTEGER NOT NULL DEFAULT 0,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facility_cat_scope  ON facility_asset_categories(scope);
CREATE INDEX IF NOT EXISTS idx_facility_cat_active ON facility_asset_categories(is_active);

DO $$ BEGIN
  CREATE TRIGGER update_facility_cat_updated_at
    BEFORE UPDATE ON facility_asset_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_asset_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_cat_select" ON facility_asset_categories;
DROP POLICY IF EXISTS "fac_cat_write"  ON facility_asset_categories;

CREATE POLICY "fac_cat_select" ON facility_asset_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_cat_write" ON facility_asset_categories
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Table: facility_assets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  floor_id        UUID REFERENCES location_floors(id) ON DELETE SET NULL,
  space_unit_id   UUID REFERENCES space_units(id) ON DELETE SET NULL,
  category_id     UUID NOT NULL REFERENCES facility_asset_categories(id) ON DELETE RESTRICT,
  name            VARCHAR(255) NOT NULL,         -- "UDM-Pro Andheri Main"
  asset_code      VARCHAR(40)  NOT NULL,         -- "AND-UDM-001" — unique per location
  make            VARCHAR(120),
  model           VARCHAR(120),
  serial_number   VARCHAR(160),
  mac_address     VARCHAR(40),
  ip_address      VARCHAR(40),
  purchase_date   DATE,
  warranty_expiry DATE,
  vendor          VARCHAR(160),
  status          facility_asset_status NOT NULL DEFAULT 'active',
  location_notes  TEXT,                          -- "Server rack, Floor 2"
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES public.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (location_id, asset_code)
);

CREATE INDEX IF NOT EXISTS idx_facility_assets_location  ON facility_assets(location_id);
CREATE INDEX IF NOT EXISTS idx_facility_assets_floor     ON facility_assets(floor_id);
CREATE INDEX IF NOT EXISTS idx_facility_assets_unit      ON facility_assets(space_unit_id);
CREATE INDEX IF NOT EXISTS idx_facility_assets_category  ON facility_assets(category_id);
CREATE INDEX IF NOT EXISTS idx_facility_assets_status    ON facility_assets(status);

DO $$ BEGIN
  CREATE TRIGGER update_facility_assets_updated_at
    BEFORE UPDATE ON facility_assets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_assets_select" ON facility_assets;
DROP POLICY IF EXISTS "fac_assets_write"  ON facility_assets;

CREATE POLICY "fac_assets_select" ON facility_assets
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_assets_write" ON facility_assets
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Sequence + helper for issue_number generation (per-scope per-year)
-- e.g. IT-2026-00042
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS facility_issue_seq;

-- ---------------------------------------------------------------------------
-- Table: facility_issues
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_issues (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number             VARCHAR(40) NOT NULL UNIQUE,    -- "IT-2026-00042"

  scope                    facility_scope NOT NULL DEFAULT 'it',
  category_id              UUID NOT NULL REFERENCES facility_asset_categories(id) ON DELETE RESTRICT,

  -- Where
  location_id              UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  floor_id                 UUID REFERENCES location_floors(id) ON DELETE SET NULL,
  space_unit_id            UUID REFERENCES space_units(id) ON DELETE SET NULL,
  asset_id                 UUID REFERENCES facility_assets(id) ON DELETE SET NULL,

  -- What
  title                    VARCHAR(255) NOT NULL,
  description              TEXT,
  priority                 facility_issue_priority NOT NULL DEFAULT 'medium',
  status                   facility_issue_status   NOT NULL DEFAULT 'new',

  -- Reporter
  reported_by              UUID REFERENCES public.users(id),
  reporter_name            VARCHAR(160),
  reporter_email           VARCHAR(255),
  reporter_phone           VARCHAR(40),
  reported_via             facility_reported_via NOT NULL DEFAULT 'walk_in',
  linked_feedback_id       UUID,                     -- soft FK to feedback (Phase 2)

  -- Assignment
  assigned_to              UUID REFERENCES public.users(id),
  assigned_at              TIMESTAMPTZ,
  assigned_by              UUID REFERENCES public.users(id),

  -- Lifecycle timestamps
  reported_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at          TIMESTAMPTZ,
  started_at               TIMESTAMPTZ,
  resolved_at              TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,

  -- SLA
  sla_target_at            TIMESTAMPTZ,              -- when it must be resolved by
  sla_breached             BOOLEAN NOT NULL DEFAULT false,

  -- Resolution
  resolution_root_cause    facility_root_cause,
  resolution_notes         TEXT,
  resolution_time_minutes  INTEGER,                  -- acknowledged → resolved
  parts_cost               NUMERIC(12,2) NOT NULL DEFAULT 0,
  parts_notes              TEXT,

  -- Satisfaction
  satisfaction_rating      INTEGER CHECK (satisfaction_rating BETWEEN 1 AND 5),
  satisfaction_comment     TEXT,
  satisfaction_token       UUID DEFAULT gen_random_uuid(),  -- public link
  satisfaction_requested_at TIMESTAMPTZ,
  satisfaction_received_at  TIMESTAMPTZ,

  reopen_count             INTEGER NOT NULL DEFAULT 0,

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_issues_scope        ON facility_issues(scope);
CREATE INDEX IF NOT EXISTS idx_fac_issues_status       ON facility_issues(status);
CREATE INDEX IF NOT EXISTS idx_fac_issues_priority     ON facility_issues(priority);
CREATE INDEX IF NOT EXISTS idx_fac_issues_location     ON facility_issues(location_id);
CREATE INDEX IF NOT EXISTS idx_fac_issues_floor        ON facility_issues(floor_id);
CREATE INDEX IF NOT EXISTS idx_fac_issues_asset        ON facility_issues(asset_id);
CREATE INDEX IF NOT EXISTS idx_fac_issues_assigned     ON facility_issues(assigned_to);
CREATE INDEX IF NOT EXISTS idx_fac_issues_reported     ON facility_issues(reported_by);
CREATE INDEX IF NOT EXISTS idx_fac_issues_category     ON facility_issues(category_id);
CREATE INDEX IF NOT EXISTS idx_fac_issues_created      ON facility_issues(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fac_issues_sla_breached ON facility_issues(sla_breached) WHERE sla_breached = true;
CREATE INDEX IF NOT EXISTS idx_fac_issues_open
  ON facility_issues(status)
  WHERE status IN ('new', 'acknowledged', 'in_progress', 'reopened');
CREATE INDEX IF NOT EXISTS idx_fac_issues_sat_token    ON facility_issues(satisfaction_token);
CREATE INDEX IF NOT EXISTS idx_fac_issues_feedback     ON facility_issues(linked_feedback_id) WHERE linked_feedback_id IS NOT NULL;

DO $$ BEGIN
  CREATE TRIGGER update_facility_issues_updated_at
    BEFORE UPDATE ON facility_issues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_issues_select" ON facility_issues;
DROP POLICY IF EXISTS "fac_issues_insert" ON facility_issues;
DROP POLICY IF EXISTS "fac_issues_update" ON facility_issues;
DROP POLICY IF EXISTS "fac_issues_delete" ON facility_issues;

-- All authenticated users can read issues (location-level filtering happens in app layer)
CREATE POLICY "fac_issues_select" ON facility_issues
  FOR SELECT TO authenticated USING (true);

-- Anyone in the team can report
CREATE POLICY "fac_issues_insert" ON facility_issues
  FOR INSERT TO authenticated WITH CHECK (true);

-- Update: technicians, IT managers, managers, admins
CREATE POLICY "fac_issues_update" ON facility_issues
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager', 'it_manager', 'it_technician', 'fms', 'office_admin', 'floor_manager')
        AND is_active = true
    )
  );

-- Delete: only admin + IT manager
CREATE POLICY "fac_issues_delete" ON facility_issues
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager')
        AND is_active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Table: facility_issue_attachments
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE facility_attachment_phase AS ENUM ('report', 'progress', 'resolution');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS facility_issue_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id        UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  file_url        TEXT NOT NULL,
  file_path       TEXT NOT NULL,                 -- storage path for signed URLs
  file_type       VARCHAR(20) NOT NULL DEFAULT 'image',  -- image | document
  caption         TEXT,
  phase           facility_attachment_phase NOT NULL DEFAULT 'report',
  uploaded_by     UUID REFERENCES public.users(id),
  uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_attach_issue ON facility_issue_attachments(issue_id);

ALTER TABLE facility_issue_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_attach_select" ON facility_issue_attachments;
DROP POLICY IF EXISTS "fac_attach_write"  ON facility_issue_attachments;

CREATE POLICY "fac_attach_select" ON facility_issue_attachments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_attach_write" ON facility_issue_attachments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Table: facility_issue_events  (timeline / activity log per issue)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facility_issue_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id      UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  event_type    VARCHAR(60) NOT NULL,            -- created | status_changed | assigned | comment | photo_added | resolved | reopened | sla_breached | satisfaction
  actor_id      UUID REFERENCES public.users(id),
  actor_label   VARCHAR(160),                    -- snapshot of actor name at time of event
  message       TEXT,                            -- human-readable summary
  payload       JSONB DEFAULT '{}'::JSONB,       -- structured details (from/to status, etc.)
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_events_issue   ON facility_issue_events(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fac_events_actor   ON facility_issue_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_fac_events_type    ON facility_issue_events(event_type);

ALTER TABLE facility_issue_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_events_select" ON facility_issue_events;
DROP POLICY IF EXISTS "fac_events_insert" ON facility_issue_events;

CREATE POLICY "fac_events_select" ON facility_issue_events
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "fac_events_insert" ON facility_issue_events
  FOR INSERT TO authenticated WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Storage bucket: facility-issue-photos (private)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'facility-issue-photos',
  'facility-issue-photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can upload facility issue photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload facility issue photos"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'facility-issue-photos')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can view facility issue photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view facility issue photos"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'facility-issue-photos')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can delete facility issue photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can delete facility issue photos"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'facility-issue-photos')
    $policy$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Seed: IT asset categories
-- ---------------------------------------------------------------------------

INSERT INTO facility_asset_categories
  (scope, name, slug, icon, description,
   default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs,
   sort_order)
VALUES
  ('it', 'UDM / Router',          'it-udm-router',  'Router',       'UniFi Dream Machine, ISP routers, gateway',          1, 4,  12, 48, 10),
  ('it', 'Firewall',              'it-firewall',    'ShieldAlert',  'Network firewall / security appliance',              1, 4,  12, 48, 15),
  ('it', 'WiFi Access Point',     'it-wifi-ap',     'Wifi',         'Ceiling / wall WiFi access points',                  2, 6,  24, 72, 20),
  ('it', 'Switch',                'it-switch',      'Network',      'Managed / unmanaged network switches',               1, 4,  12, 48, 30),
  ('it', 'LAN Socket / Cabling',  'it-lan',         'Cable',        'Wall sockets, patch cables, structured cabling',     4, 8,  24, 72, 40),
  ('it', 'ISP Link / Internet',   'it-isp',         'Globe',        'Primary / backup ISP connectivity',                  1, 2,  6,  24, 50),
  ('it', 'Server / NAS',          'it-server',      'Server',       'On-prem servers, storage, NAS units',                1, 4,  12, 48, 60),
  ('it', 'CCTV / Surveillance',   'it-cctv',        'Camera',       'IP cameras, NVR, recording infrastructure',          4, 12, 48, 96, 70),
  ('it', 'Printer',               'it-printer',     'Printer',      'Network / shared printers',                          8, 24, 48, 96, 80),
  ('it', 'Member Workstation',    'it-workstation', 'Monitor',      'Member-facing terminals, kiosks',                    4, 12, 24, 72, 90),
  ('it', 'Door Access / Biometric','it-access',     'KeyRound',     'Door access controllers, biometric readers',         2, 6,  24, 72, 95),
  ('it', 'Other IT',              'it-other',       'HelpCircle',   'Anything else IT-related',                           4, 12, 48, 96, 100)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT ALL ON facility_asset_categories  TO authenticated;
GRANT ALL ON facility_assets            TO authenticated;
GRANT ALL ON facility_issues            TO authenticated;
GRANT ALL ON facility_issue_attachments TO authenticated;
GRANT ALL ON facility_issue_events      TO authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE facility_issue_seq TO authenticated;
