-- Asset event log: lightweight record of what happened at an asset
-- (maintenance done, inspection, fault observed, part replaced, cleaning, etc.)

CREATE TABLE facility_asset_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES facility_assets(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN (
    'maintenance', 'inspection', 'fault_observed', 'part_replaced',
    'cleaning', 'installation', 'relocation', 'other'
  )),
  note        text,
  photo_urls  jsonb DEFAULT '[]'::jsonb,
  logged_by   uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_asset_events_asset ON facility_asset_events(asset_id, created_at DESC);

ALTER TABLE facility_asset_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read asset events"
  ON facility_asset_events FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert asset events"
  ON facility_asset_events FOR INSERT TO authenticated WITH CHECK (true);
