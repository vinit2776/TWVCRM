-- Allow 'nudged' as a query timeline event.
--
-- The chase cron (src/app/api/cron/query-escalation/route.ts) can now fire for
-- two reasons: 48h of silence on any open thread (the original behaviour), or
-- a thread that has gone past its needed_by date. When it chases, it writes a
-- typed timeline event so the thread shows "Nudged automatically" inline —
-- the same reasoning as 'resolved'/'reopened'/'retargeted'. A chase that
-- changed who was being paged without leaving a trace would be the kind of
-- silent side effect this table exists to avoid.
--
-- Nudges deliberately do NOT write an audit_trail row: audit_trail is for
-- state changes to the record, and an automated reminder isn't one. See
-- logQueryAudit in src/lib/queries/server.ts.
--
-- last_nudged_at already exists on queries (added in 00421) and caps chasing
-- at one nudge per query per day.

ALTER TABLE query_messages DROP CONSTRAINT query_messages_event_type_check;
ALTER TABLE query_messages ADD  CONSTRAINT query_messages_event_type_check
  CHECK (event_type IN ('message', 'resolved', 'reopened', 'retargeted', 'nudged'));

-- 'nudged' rows carry no body and no human author. created_by is NOT NULL, so
-- the cron stamps the thread's creator as a stand-in actor; the event_type is
-- what tells the UI it was automatic, not the name on it.

NOTIFY pgrst, 'reload schema';
