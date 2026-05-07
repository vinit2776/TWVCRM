-- ============================================================
-- Migration 00132: Drop the closed booking state (rollback of 00131)
-- ============================================================
-- The explicit `closed` state added in 00131 turned out to be
-- busywork for staff — a booking ending at `checked_out` with
-- payment settled is already a clean terminal signal that finance
-- can query directly. Asking staff to click another "Close Booking"
-- button after Check Out added a click without solving a real
-- problem.
--
-- This migration drops the columns and index added in 00131. The
-- enum value 'closed' on booking_status is left in place because
-- Postgres doesn't support dropping enum values cleanly — it's
-- now a dead value with no code references.
-- ============================================================

DROP INDEX IF EXISTS idx_bookings_needs_wrapup;

ALTER TABLE bookings
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS closed_by;
