-- Waiting for space: a real enquiry we cannot offer yet (a centre that is not open, or no space of
-- the size they need) is parked instead of being chased. It leaves the follow-up lists, never goes
-- stale, and comes back when a person takes it out after space opens.
--
-- `parked_enquiries` holds what was wanted and why we could not offer it: where (a centre, or an
-- area we have no centre in), the type and seats, the reason, a note, and an optional look-again
-- date (a reminder for staff only). `state`: waiting, space_available (set later by the matcher),
-- released (taken out). `leads.parked_at` is the quick flag the lists filter on; it is set while a
-- row is waiting or space_available and cleared on release.
-- Also seeds the switch `space_waiting_enabled` (off). Written only by the routes (service role).
-- Rollback:
--   DROP TABLE IF EXISTS parked_enquiries; ALTER TABLE leads DROP COLUMN IF EXISTS parked_at;
--   DELETE FROM app_settings WHERE key = 'space_waiting_enabled';

ALTER TABLE leads ADD COLUMN IF NOT EXISTS parked_at timestamptz;

CREATE TABLE IF NOT EXISTS parked_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  other_area text,
  workspace_type text,
  seats_needed integer CHECK (seats_needed IS NULL OR seats_needed BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (reason IN ('not_open', 'no_space_of_size', 'other')),
  note text,
  look_again_on date,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'space_available', 'released')),
  parked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  parked_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users(id) ON DELETE SET NULL,
  released_at timestamptz,
  CHECK (location_id IS NOT NULL OR other_area IS NOT NULL)
);

-- A lead is parked at most once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parked_enquiries_active ON parked_enquiries (lead_id) WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS idx_parked_enquiries_state ON parked_enquiries (state, location_id);
CREATE INDEX IF NOT EXISTS idx_leads_parked ON leads (parked_at) WHERE parked_at IS NOT NULL;

ALTER TABLE parked_enquiries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "parked_enquiries_select" ON parked_enquiries;
CREATE POLICY "parked_enquiries_select" ON parked_enquiries FOR SELECT TO authenticated USING (true);

INSERT INTO app_settings (key, value)
VALUES ('space_waiting_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
