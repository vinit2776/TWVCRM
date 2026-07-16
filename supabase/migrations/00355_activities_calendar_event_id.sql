-- ============================================================
-- Migration 00355: Activity calendar event ID
--
-- Stores the Google Calendar event ID created for a lead follow-up
-- reminder, so a later reschedule can update the same event instead
-- of creating a duplicate.
-- ============================================================

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
