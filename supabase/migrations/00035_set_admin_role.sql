-- ==========================================
-- Migration 00035: Bootstrap admin role for vinit@theworkvilla.com
-- ==========================================
-- Problem:
--   The handle_new_user() trigger creates every new user with
--   role = 'sales_rep' (the column default).  There is no bootstrap
--   step that promotes the first / owner account to 'admin'.
--   The PATCH /api/team/[id] handler requires the calling user to
--   already be 'admin' to change roles — a chicken-and-egg lock-out.
--
-- Fix:
--   Directly set the role to 'admin' for vinit@theworkvilla.com.
--   The WHERE clause is idempotent — it's a no-op if the role is
--   already 'admin'.
-- ==========================================

UPDATE public.users
SET    role = 'admin'
WHERE  email = 'vinit@theworkvilla.com'
  AND  role  != 'admin';
