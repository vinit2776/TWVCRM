-- 00619_enquiry_next_step.sql
-- Each enquiry gets a "next step" and a follow-up date so the team can see what happens
-- next, and who set it, without leaving the Enquiry Log. Claim / resolve state (00584)
-- is unchanged: claimed = in progress, resolved = converted / not interested / no response.

ALTER TABLE lead_enquiries
  ADD COLUMN IF NOT EXISTS next_step     text,
  ADD COLUMN IF NOT EXISTS follow_up_at  timestamptz,
  ADD COLUMN IF NOT EXISTS next_step_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_step_at  timestamptz;

-- Rollback:
--   ALTER TABLE lead_enquiries DROP COLUMN next_step, DROP COLUMN follow_up_at,
--     DROP COLUMN next_step_by, DROP COLUMN next_step_at;

-- ─── Update history ──────────────────────────────────────────────────────────
-- One row per "Log update": what happened, an optional note, and the next step / follow-up
-- date set at that moment. lead_enquiries.next_step / follow_up_at hold the CURRENT plan
-- (the latest update's), so lists stay cheap; this table is the history behind it.
CREATE TABLE IF NOT EXISTS enquiry_updates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id    uuid NOT NULL REFERENCES lead_enquiries(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'call_no_answer', 'spoke_interested', 'visit_booked', 'visit_done',
                  'details_sent', 'waiting_customer', 'note')),
  note          text,
  next_step     text,
  follow_up_at  timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enquiry_updates_enquiry_idx ON enquiry_updates (enquiry_id, created_at DESC);

ALTER TABLE enquiry_updates ENABLE ROW LEVEL SECURITY;

-- Written only by the enquiry updates API (service role, bypasses RLS).
DROP POLICY IF EXISTS "enquiry_updates_select_authenticated" ON enquiry_updates;
CREATE POLICY "enquiry_updates_select_authenticated"
  ON enquiry_updates FOR SELECT TO authenticated USING (true);

-- Rollback (in addition to the column drops above):  DROP TABLE enquiry_updates;

-- ─── Spam ────────────────────────────────────────────────────────────────────
-- A person can mark an enquiry as spam. It is stored as a resolution outcome, so it leaves
-- every active queue and count on its own, and is restored by clearing the resolution.
ALTER TABLE lead_enquiries DROP CONSTRAINT IF EXISTS lead_enquiries_resolution_outcome_check;
ALTER TABLE lead_enquiries
  ADD CONSTRAINT lead_enquiries_resolution_outcome_check
  CHECK (resolution_outcome IN ('converted', 'not_interested', 'no_response', 'superseded', 'spam'));
-- Rollback: restore the 4-value check above after clearing any 'spam' rows.
