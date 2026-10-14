-- =====================================================================
-- Migration 00591: enquiry_viewer role
-- =====================================================================
-- A role for people who only need to watch enquiry activity (e.g. the
-- social media manager tracking ad performance). The app restricts it to
-- /leads/enquiry-log and masks customer mobile numbers on that API.
--
-- Standalone on purpose: a new enum value can't be referenced in the same
-- transaction that adds it (see 00115, 00177/00178).
--
-- Rollback: enum values can't be dropped. Re-assign any enquiry_viewer
-- users to another role and the value is simply unused.
-- =====================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'enquiry_viewer';
