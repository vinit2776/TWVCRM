-- Add 'grace_period' to the case_status enum.
-- The automated VO renewal cron (src/app/api/cron/vo-renewal/route.ts) has always
-- written this value, but it was never added to the enum, so that UPDATE fails.
-- Must run in its own transaction (committed before any UPDATE uses the new value).
ALTER TYPE case_status ADD VALUE IF NOT EXISTS 'grace_period' AFTER 'renewal_due';
