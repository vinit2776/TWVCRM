-- Migration: 00058_add_accounts_fms_roles
-- Adds two new operational roles to the user_role ENUM:
--   accounts  — finance/accounts team (billing, vendor bills, view-only CRM)
--   fms       — Facility Manager (full transactional procurement access)
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- Apply each statement individually in the Supabase SQL editor.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'accounts';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fms';
