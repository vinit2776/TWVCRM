-- ============================================================
-- Migration 00130: Closed booking state
-- ============================================================
-- Adds an explicit terminal "closed" state to the booking lifecycle so
-- finance and management can tell at a glance which transactions are
-- fully wrapped (payment + addons settled, internal rating + customer
-- feedback handled). Today, a booking sits at `checked_out` indefinitely
-- with no signal that the wrap-up ritual is complete.
--
-- Rules (locked with product owner):
--   • closed is set ONLY by an explicit "Mark Closed" action — never
--     auto-derived. The transition is the staff member's affirmation.
--   • A booking can only be closed FROM checked_out (or cancelled /
--     no_show — those are already terminal but should also set
--     closed_at = updated_at to make "is this booking done?" a single
--     timestamp check; see backfill below).
--   • Reopen is allowed by floor_manager+ within 24 hours, audit-logged.
--   • Anywhere `cancelled / checked_out / no_show` was previously
--     treated as terminal-locked, `closed` joins the list.
-- ============================================================

ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'closed';

-- New column: when the booking was explicitly marked closed. Nullable —
-- legacy bookings stay null and are treated as "checked_out, awaiting
-- wrap-up" by the new "needs attention" widgets.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Index for the "needs wrap-up" dashboard widget — bookings that are
-- checked_out but don't have closed_at. Partial index so it's tiny.
CREATE INDEX IF NOT EXISTS idx_bookings_needs_wrapup
  ON bookings(updated_at DESC)
  WHERE status = 'checked_out' AND closed_at IS NULL;
