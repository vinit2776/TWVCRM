-- Tours: who accompanies, when the customer arrived, and the visit report with photos.
--
-- `accompanier_id`: a colleague tagged to join the customer on the visit. `arrived_at`: when the host
-- marked the customer as arrived. A visit report is written once per tour by the host after the
-- visit: an outcome, comments and at least one photo (the routes enforce that); the accompanier may
-- add their own note. Photos live in the existing private storage bucket under tour-reports/<tour>/,
-- and these rows point at them. Reports are written only by the routes (service role); everyone
-- signed in may read them, like the lead and its activities.
-- Additive and idempotent. Rollback:
--   DROP TABLE IF EXISTS tour_report_photos; DROP TABLE IF EXISTS tour_reports;
--   ALTER TABLE activities DROP COLUMN IF EXISTS accompanier_id, DROP COLUMN IF EXISTS arrived_at;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS accompanier_id uuid CONSTRAINT activities_accompanier_id_fkey REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz;

CREATE TABLE IF NOT EXISTS tour_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL UNIQUE REFERENCES activities(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  reported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('keen', 'thinking', 'comparing', 'not_a_fit')),
  comments text NOT NULL,
  accompanier_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tour_report_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES tour_reports(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tour_reports_lead ON tour_reports (lead_id);
CREATE INDEX IF NOT EXISTS idx_tour_report_photos_report ON tour_report_photos (report_id);

ALTER TABLE tour_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_report_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tour_reports_select" ON tour_reports;
CREATE POLICY "tour_reports_select" ON tour_reports FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "tour_report_photos_select" ON tour_report_photos;
CREATE POLICY "tour_report_photos_select" ON tour_report_photos FOR SELECT TO authenticated USING (true);
