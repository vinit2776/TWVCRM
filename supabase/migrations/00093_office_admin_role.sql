-- =====================================================================
-- Migration 00093: Add office_admin role
-- =====================================================================
-- office_admin: can access Procurement and Operations only.
-- Cannot access Sales, Finance, Virtual Offices, or Admin sections.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- =====================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'office_admin';
