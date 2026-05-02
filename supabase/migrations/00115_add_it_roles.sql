-- =====================================================================
-- Migration 00115: Add IT roles for Facility Issues module
-- =====================================================================
-- it_manager:    Manages IT infrastructure across all facilities.
--                Sees all issues, assigns technicians, views team KPIs,
--                manages assets.
-- it_technician: Field technician. Sees assigned + unassigned issues
--                across all locations (open coverage at the moment).
--                Updates status, adds notes/photos, marks resolved.
--
-- NOTE: ALTER TYPE ... ADD VALUE values cannot be referenced in the
-- same migration that adds them, so this is intentionally a small,
-- standalone migration. Tables and RLS policies arrive in 00116.
-- =====================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'it_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'it_technician';
