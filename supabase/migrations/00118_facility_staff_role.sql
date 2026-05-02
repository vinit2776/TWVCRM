-- Migration 00118: Add facility_staff role
-- A focused role with access to:
--   • Facility → Issues and My Issues (roles: null — always visible)
--   • Operations → Vouchers
-- No access to Sales, Finance, Procurement, Admin, etc.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'facility_staff';
