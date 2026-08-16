-- ============================================================
-- Migration 00422: cron_health cleanup
-- ============================================================
-- Companion to the fix that made cron health pings actually write.
--
-- Background: migration 00091 created cron_health and seeded five rows.
-- Migration 00110 then enabled RLS with a SELECT-only policy, noting that
-- "all writes come from the server (service role)" — but the writer,
-- /api/health/cron-ping, used the cookie-scoped client, which runs as `anon`
-- for a cron request. Every ping from 2026-04-22 onward was denied, and
-- pingCronHealth() never checked the response, so nothing surfaced it.
--
-- The practical effect: three of the five rows still carried the identical
-- seed timestamp from 00091 and had never been written by a real run.
--
-- This migration removes rows that no longer correspond to a scheduled job.
-- Live jobs are left alone; their rows are overwritten on the next real ping.
-- ============================================================

-- 'billing/auto-generate' was seeded by 00091, but the auto-billing cron was
-- deliberately retired on 2026-05-30 ("feat(billing): pause auto-billing cron,
-- switch to manual trigger + reminder") and removed from vercel.json. It is
-- now driven manually, so nothing will ever ping this job again and it would
-- otherwise report permanently stale once staleness detection works.
DELETE FROM cron_health WHERE job = 'billing/auto-generate';

-- Drop any row whose job name predates the naming convention now enforced in
-- code (job name = route path with "/api/" stripped, e.g. "cron/db-backup").
-- These would linger forever as stale entries no live job writes to.
DELETE FROM cron_health
WHERE job NOT LIKE 'cron/%'
  AND job NOT IN ('digest', 'petty-cash/day-book');

COMMENT ON TABLE cron_health IS
  'Last run time/status per scheduled cron job. Written ONLY by '
  '/api/health/cron-ping via the service-role client (RLS has no write policy). '
  'Job name = route path minus "/api/". Do not seed rows here: a seeded row is '
  'indistinguishable from a real run and masks a job that has never executed.';
