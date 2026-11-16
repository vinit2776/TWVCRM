-- Query lifecycle: Open -> Answered -> Closed, and a safe path for a query
-- whose bill got paid (nudge the asker first, auto-close only after a grace
-- period and only when it was clearly about the amount/invoice).
--
-- "Answered" is derived from the thread, not stored.
--
-- bill_corrected_at   set when the bill the query is about has its amount or
--                     invoice corrected while the query is open. It is the
--                     evidence that the query was about the amount/invoice;
--                     without it a paid-bill query is never auto-closed.
-- paid_nudged_at      when the asker was sent the one "bill paid, please
--                     confirm and close" reminder.
-- resolution_kind     'payment' when the system closed it ("Resolved by
--                     payment"); null for a normal close by a person.
--
-- New timeline events: 'paid_nudge' (the reminder) and 'auto_resolved' (the
-- system close). Both are stamped with the asker as stand-in author, like
-- 'nudged'; the event type is what marks them automatic.
--
-- Rollback: UPDATE query_messages SET event_type = 'nudged' WHERE event_type
-- = 'paid_nudge'; UPDATE query_messages SET event_type = 'resolved' WHERE
-- event_type = 'auto_resolved'; re-add the constraint from 00593; then DROP
-- the three columns.

ALTER TABLE queries
  ADD COLUMN IF NOT EXISTS bill_corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_nudged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_kind   TEXT CHECK (resolution_kind IN ('payment'));

ALTER TABLE query_messages DROP CONSTRAINT IF EXISTS query_messages_event_type_check;
ALTER TABLE query_messages ADD  CONSTRAINT query_messages_event_type_check
  CHECK (event_type IN (
    'message', 'resolved', 'reopened', 'retargeted', 'nudged',
    'payment_verified', 'payment_rejected', 'payment_not_found',
    'paid_nudge', 'auto_resolved'
  ));

NOTIFY pgrst, 'reload schema';
