-- Add 'viewer' to the user_role enum.
-- Viewers have read-only access to all menus except Admin/Settings.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer';
