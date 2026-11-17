-- 00693_lost_leads_not_disabled.sql
-- "Not interested" used to close a lead AND disable (archive) it, which hid it from the Leads list
-- and its search. Closing a lead no longer disables it (disabled is for contacts who asked not to
-- be contacted). This re-enables the leads that were only disabled by that action, identified by
-- the reason it stamped. Leads disabled by hand or by the stale-lead job are untouched.
UPDATE leads
SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
WHERE archived_at IS NOT NULL
  AND archive_reason LIKE 'Not interested:%'
  AND status IN ('lost', 'junk');

-- Rollback: none needed for behaviour. To re-hide, set archived_at = lost_at/updated_at and
-- archive_reason = 'Not interested: ...' for the same leads (the original reason text is not kept).
