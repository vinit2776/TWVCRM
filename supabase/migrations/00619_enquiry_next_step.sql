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
