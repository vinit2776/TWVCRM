-- =====================================================================
-- Migration 00642: coordinator role
-- =====================================================================
-- A role for the operations coordinator: everything a sales rep sees, plus
-- Operations, Procurement (create material requests, view everything, no
-- approvals) and day-to-day Facility. No Finance, Payroll, Attendance or
-- Admin access — the app enforces that in the sidebar and API role lists.
--
-- Standalone on purpose: a new enum value can't be referenced in the same
-- transaction that adds it (see 00115, 00177/00178, 00591).
--
-- Rollback: enum values can't be dropped. Re-assign any coordinator users
-- to another role and the value is simply unused.
-- =====================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'coordinator';
