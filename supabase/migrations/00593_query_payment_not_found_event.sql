-- "Not found yet" gets its own timeline event.
--
-- Until now, accounts answering "I can't see it in the bank yet" on a reported
-- payment posted an ordinary 'message'. That is indistinguishable from any
-- other reply, so nothing could say when a report was last actually checked
-- against the bank. A dedicated event type makes "last checked" exact: the
-- Tally Inbox To verify list reads it, rather than guessing from replies.
--
-- Rollback: UPDATE query_messages SET event_type = 'message'
--   WHERE event_type = 'payment_not_found'; then re-add the constraint from
--   00510 without the new value.
ALTER TABLE query_messages DROP CONSTRAINT IF EXISTS query_messages_event_type_check;
ALTER TABLE query_messages ADD  CONSTRAINT query_messages_event_type_check
  CHECK (event_type IN (
    'message', 'resolved', 'reopened', 'retargeted', 'nudged',
    'payment_verified', 'payment_rejected', 'payment_not_found'
  ));

NOTIFY pgrst, 'reload schema';
