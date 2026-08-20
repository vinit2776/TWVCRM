-- Tracks whether a billing_queries thread has already been WhatsApp-escalated
-- for its current stretch of silence, so the escalation cron (every 6h,
-- see src/app/api/cron/billing-query-escalation/route.ts) doesn't re-page
-- the same unanswered query on every run. Cleared back to NULL whenever a
-- new message lands, so a query that goes quiet again after a reply is
-- eligible for escalation again.
ALTER TABLE billing_queries
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
