-- Retry: 00412 was recorded as applied in schema_migrations but the column
-- was never actually created (name collision with a concurrent session's
-- migration history, or a swallowed error). Re-issue defensively.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_payment_recorded_by uuid REFERENCES users(id);

NOTIFY pgrst, 'reload schema';
