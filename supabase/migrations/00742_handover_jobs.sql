-- Hand-over jobs: "Priya, send a proposal to this customer", kept on the existing tasks table.
--
-- `kind` says what the job is; plain tasks stay 'general' and are untouched. `brief` holds what the
-- giver wrote for the person doing it (what was discussed, what kind of proposal); the lead itself
-- is read live. `proposal_id` ties a send-a-proposal job to the proposal that finishes it.
-- tasks has open row-level security (any signed-in user), so who may complete or edit a job is
-- enforced in the routes, not here.
--
-- Also seeds the switch `handover_jobs_enabled` (off): nothing can be handed over until it is on.
-- Rollback:
--   DROP INDEX IF EXISTS idx_tasks_proposal_id, idx_tasks_open_jobs;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS brief, DROP COLUMN IF EXISTS handed_over_by,
--     DROP COLUMN IF EXISTS proposal_id, DROP COLUMN IF EXISTS completion_note;
--   DELETE FROM app_settings WHERE key = 'handover_jobs_enabled';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'general'
    CHECK (kind IN ('general', 'call_back', 'book_tour', 'send_proposal', 'other')),
  ADD COLUMN IF NOT EXISTS brief jsonb,
  ADD COLUMN IF NOT EXISTS handed_over_by uuid CONSTRAINT tasks_handed_over_by_fkey REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposal_id uuid CONSTRAINT tasks_proposal_id_fkey REFERENCES proposals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_note text;

CREATE INDEX IF NOT EXISTS idx_tasks_proposal_id ON tasks (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_open_jobs ON tasks (assigned_to) WHERE kind <> 'general' AND status <> 'done';

INSERT INTO app_settings (key, value)
VALUES ('handover_jobs_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
