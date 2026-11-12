-- Virtual Office direct proposals (W2-2, decision D2): three new proposal
-- statuses. proposal_status is a Postgres enum, and an enum value added in a
-- transaction cannot be used in that same transaction, so this lives alone;
-- the columns that go with it are in 00683.
--
-- Rollback (enum values cannot be dropped; move rows off them first):
--   UPDATE proposals SET status = 'rejected' WHERE status IN ('withdrawn', 'declined');
--   UPDATE proposals SET status = 'sent' WHERE status = 'changes_requested';
--   (the unused enum values can stay)
--
-- proposals already has RLS enabled; no new table, so no new policy.

ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'withdrawn';
ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'changes_requested';
ALTER TYPE proposal_status ADD VALUE IF NOT EXISTS 'declined';
