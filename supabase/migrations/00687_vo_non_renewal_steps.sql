-- Non-renewal checklist progress for a lapsed Virtual Office case: services off, notice
-- delivered, customer confirmation (15 day deadline, second request drafted), GST portal check.
-- Additive only. The app tolerates this being missing (42P01 / 42703) until it is applied.
--
-- Rollback:
--   DROP TABLE IF EXISTS vo_non_renewal_steps;
--   ALTER TABLE cases
--     DROP COLUMN IF EXISTS release_status,
--     DROP COLUMN IF EXISTS confirmation_requested_at,
--     DROP COLUMN IF EXISTS confirmation_second_request_at,
--     DROP COLUMN IF EXISTS confirmation_received_at,
--     DROP COLUMN IF EXISTS delivered_at,
--     DROP COLUMN IF EXISTS gst_portal_checked_at;

CREATE TABLE IF NOT EXISTS vo_non_renewal_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL CHECK (step_key IN (
    'services_off', 'delivered', 'confirmation_requested',
    'confirmation_second_request', 'confirmation_received', 'gst_portal_check'
  )),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'issue')),
  done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_by UUID REFERENCES users(id),
  note TEXT,
  UNIQUE (case_id, step_key)
);

ALTER TABLE vo_non_renewal_steps ENABLE ROW LEVEL SECURITY;
-- Written only by the API route using the service role, so there is no insert/update policy.
DROP POLICY IF EXISTS "vo_non_renewal_steps_select" ON vo_non_renewal_steps;
CREATE POLICY "vo_non_renewal_steps_select" ON vo_non_renewal_steps
  FOR SELECT TO authenticated USING (true);

ALTER TABLE cases ADD COLUMN IF NOT EXISTS release_status TEXT
  CHECK (release_status IS NULL OR release_status IN ('not_released', 'awaiting_confirmation', 'confirmed', 'released'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS confirmation_requested_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS confirmation_second_request_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS confirmation_received_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS gst_portal_checked_at TIMESTAMPTZ;
