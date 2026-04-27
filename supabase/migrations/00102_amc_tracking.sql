-- ============================================================
-- Migration 00102: AMC Tracking — contract metadata + service events
-- ============================================================

-- ─── 1. Extend purchase_orders with AMC fields ───────────────────────────────

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS amc_start_date       DATE,
  ADD COLUMN IF NOT EXISTS amc_end_date         DATE,
  ADD COLUMN IF NOT EXISTS amc_visits_covered   INTEGER,   -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS amc_visits_used      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amc_contact_name     TEXT,
  ADD COLUMN IF NOT EXISTS amc_helpline_number  TEXT,
  ADD COLUMN IF NOT EXISTS amc_contact_email    TEXT,
  ADD COLUMN IF NOT EXISTS amc_status           TEXT NOT NULL DEFAULT 'inactive'
    CONSTRAINT purchase_orders_amc_status_check
    CHECK (amc_status IN ('inactive', 'active', 'expiring', 'exhausted', 'expired'));

CREATE INDEX IF NOT EXISTS idx_purchase_orders_amc_status ON purchase_orders(amc_status)
  WHERE amc_status != 'inactive';

-- ─── 2. amc_service_events ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS amc_service_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id             UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_number      INTEGER NOT NULL,              -- auto-seq per PO
  event_type        TEXT NOT NULL
    CONSTRAINT amc_service_events_type_check
    CHECK (event_type IN ('breakdown', 'preventive', 'remote_support', 'annual_service')),
  event_date        DATE NOT NULL,
  technician_name   TEXT,
  issue_description TEXT NOT NULL,
  resolution_notes  TEXT,
  next_scheduled_date DATE,
  report_file_url   TEXT,
  logged_by         UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT amc_service_events_unique_number UNIQUE (po_id, event_number)
);

CREATE INDEX IF NOT EXISTS idx_amc_service_events_po ON amc_service_events(po_id);
CREATE INDEX IF NOT EXISTS idx_amc_service_events_date ON amc_service_events(event_date DESC);

-- ─── 3. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE amc_service_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read amc_service_events" ON amc_service_events;
DROP POLICY IF EXISTS "Authenticated users can insert amc_service_events" ON amc_service_events;
DROP POLICY IF EXISTS "Authenticated users can update amc_service_events" ON amc_service_events;
DROP POLICY IF EXISTS "Authenticated users can delete amc_service_events" ON amc_service_events;

CREATE POLICY "Authenticated users can read amc_service_events"
  ON amc_service_events FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert amc_service_events"
  ON amc_service_events FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update amc_service_events"
  ON amc_service_events FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete amc_service_events"
  ON amc_service_events FOR DELETE USING (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.amc_service_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.amc_service_events TO service_role;

-- ─── 4. Helper function: recompute amc_status for a PO ───────────────────────

CREATE OR REPLACE FUNCTION compute_amc_status(
  p_start_date DATE,
  p_end_date   DATE,
  p_visits_covered INTEGER,   -- NULL = unlimited
  p_visits_used    INTEGER
) RETURNS TEXT AS $$
DECLARE
  today DATE := CURRENT_DATE;
BEGIN
  -- Not yet activated
  IF p_start_date IS NULL THEN
    RETURN 'inactive';
  END IF;
  -- Expired by date
  IF p_end_date IS NOT NULL AND today > p_end_date THEN
    RETURN 'expired';
  END IF;
  -- Exhausted visits (only when limited)
  IF p_visits_covered IS NOT NULL AND p_visits_used >= p_visits_covered THEN
    RETURN 'exhausted';
  END IF;
  -- Expiring soon (within 60 days)
  IF p_end_date IS NOT NULL AND (p_end_date - today) <= 60 THEN
    RETURN 'expiring';
  END IF;
  -- Active
  IF today >= p_start_date THEN
    RETURN 'active';
  END IF;
  RETURN 'inactive';
END;
$$ LANGUAGE plpgsql IMMUTABLE;
