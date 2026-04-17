-- ============================================================
-- Space Headcount Tracking
-- Records manual occupancy readings throughout the day.
-- Area columns match the 4 physical space types at TWV.
-- Supports future correlation with bookings, revenue, leads.
-- ============================================================

CREATE TABLE IF NOT EXISTS space_headcounts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which location was counted
  location_id       UUID        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  -- The actual date/time the count was taken (not when it was entered)
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who recorded it
  recorded_by       UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Area breakdowns — all optional; NULL = not counted this reading
  open_desk         INT         CHECK (open_desk         >= 0),  -- hot desks / open floor
  private_cabin     INT         CHECK (private_cabin     >= 0),  -- private offices / cabins
  meeting_room      INT         CHECK (meeting_room      >= 0),  -- small meeting rooms
  conference_room   INT         CHECK (conference_room   >= 0),  -- large conference rooms

  -- Total occupancy (required; can equal sum of above or a direct count)
  total_count       INT         NOT NULL CHECK (total_count >= 0),

  notes             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for common queries: by location + date range
CREATE INDEX IF NOT EXISTS idx_space_headcounts_location_recorded
  ON space_headcounts (location_id, recorded_at DESC);

-- Index for time-series queries
CREATE INDEX IF NOT EXISTS idx_space_headcounts_recorded_at
  ON space_headcounts (recorded_at DESC);

-- ─── Location capacity config + headcount flag ────────────────────────────────
-- capacity_config: max seat count per area type for utilisation %.
-- Structure: { "open_desk": 40, "private_cabin": 10, "meeting_room": 4, "conference_room": 2 }
ALTER TABLE locations ADD COLUMN IF NOT EXISTS capacity_config JSONB DEFAULT '{}'::jsonb;

-- requires_headcount: opt-in flag. Dedicated single-tenant locations don't need it.
-- Only locations with this flag = true will appear in headcount reminders & cron escalation.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS requires_headcount BOOLEAN NOT NULL DEFAULT false;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE space_headcounts ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read headcounts
CREATE POLICY "headcounts_select"
  ON space_headcounts FOR SELECT
  TO authenticated
  USING (true);

-- Any authenticated user can insert (floor managers, office admins, etc.)
CREATE POLICY "headcounts_insert"
  ON space_headcounts FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Only admins / managers can update or delete
CREATE POLICY "headcounts_update"
  ON space_headcounts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
    )
  );

CREATE POLICY "headcounts_delete"
  ON space_headcounts FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
    )
  );
