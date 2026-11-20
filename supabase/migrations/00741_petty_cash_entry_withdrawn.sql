-- Migration 00741: let a person withdraw a rejected petty cash expense
-- A rejected expense can be fixed and resubmitted, or withdrawn when it should not be pursued
-- (duplicate, personal spend). Withdrawing keeps the row and its history; the status stays
-- 'rejected' so nothing that reads pending/approved changes, and withdrawn_at marks it closed.
-- Rollback: ALTER TABLE petty_cash_entries DROP COLUMN withdrawn_at;
ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
